import { forceCollide } from "d3-force-3d";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods } from "react-force-graph-3d";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { fmt, STATUS } from "../format";
import type { AIModel, Providers } from "../types";
import { buildGraph, structureKey, type GLink, type GNode } from "./graphData";
import {
  animateNode,
  createEngine,
  createModel,
  createProvider,
  disposeNode,
  ResourcePool,
  setStatus,
  type NodeAnim,
} from "./objects";

export interface Network3DHandle {
  resetCamera: () => void;
}

interface Props {
  models: Map<string, AIModel>;
  providers: Providers;
  selectedId: string | null;
  flashes: Record<string, "new" | "updated">;
  onSelect: (id: string) => void;
  reducedMotion: boolean;
}

const BACKGROUND = "#0b0d12";
/** Smallest network size (scene units) worth framing; below it the layout hasn't spread yet. */
const MIN_FIT_EXTENT = 250;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function tooltip(n: GNode): string {
  const status = STATUS[n.status];
  const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${status.color};margin-right:6px"></span>`;
  if (n.kind === "engine") {
    return `<div class="net-tip"><b>Live Analysis Core</b><div class="net-tip-sub">Check-up every ~10 min: Hugging Face, OpenRouter, LMArena</div></div>`;
  }
  if (n.kind === "provider") {
    return `<div class="net-tip"><b>${escapeHtml(n.name)}</b>
      <div class="net-tip-sub">${n.modelCount} model(s) · ${fmt(n.volume)} downloads/day</div>
      <div class="net-tip-sub">${dot}worst status: ${status.label}</div></div>`;
  }
  const m = n.model!;
  const extras = [
    m.metrics.elo_score != null ? `ELO ${fmt(m.metrics.elo_score)}` : null,
    m.metrics.availability_pct != null ? `availability ${fmt(m.metrics.availability_pct)}%` : null,
  ].filter(Boolean);
  return `<div class="net-tip"><b>${escapeHtml(m.name)}</b>
    <div class="net-tip-sub">${escapeHtml(m.provider)} · ${fmt(m.usage.download_count_24h)} downloads/day</div>
    <div class="net-tip-sub">${dot}${status.label}${extras.length ? " · " + extras.join(" · ") : ""}</div></div>`;
}

const Network3D = forwardRef<Network3DHandle, Props>(function Network3D(
  { models, providers, selectedId, flashes, onSelect, reducedMotion },
  ref,
) {
  const fgRef = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState<GNode | null>(null);
  // 3D labels are drawn into canvases once, so wait for Inter (max 2 s) before building the scene.
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    const timeout = new Promise((r) => setTimeout(r, 2000));
    Promise.race([document.fonts.load('500 48px "Inter Variable"'), timeout])
      .catch(() => {})
      .finally(() => setFontReady(true));
  }, []);
  const pool = useMemo(() => new ResourcePool(), []);
  const cache = useRef(new Map<string, GNode>()).current;
  const objects = useRef(new Map<string, THREE.Group>()).current;
  const fitted = useRef(false);
  const motion = !reducedMotion;

  // Rebuild the graph only when nodes/links appear or disappear; node objects
  // are reused so positions survive and new nodes grow in smoothly.
  const key = structureKey(models);
  const providerKey = JSON.stringify(Object.entries(providers).map(([k, v]) => [k, v.avatar]));
  const graph = useMemo(
    () => buildGraph(models, providers, cache),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, providerKey],
  );

  // Every poll: refresh sizes and statuses in place, without touching the layout.
  useEffect(() => {
    buildGraph(models, providers, cache);
    for (const n of cache.values()) {
      const anim = objects.get(n.id)?.userData.anim as NodeAnim | undefined;
      if (!anim) continue;
      anim.radius = n.radius;
      setStatus(pool, anim, n.status);
    }
  }, [models, providers, cache, objects, pool]);

  // A metrics/status update makes the node pulse once.
  useEffect(() => {
    for (const [id, kind] of Object.entries(flashes)) {
      const anim = objects.get(id)?.userData.anim as NodeAnim | undefined;
      if (anim && kind === "updated") anim.pulse = 1.2;
    }
  }, [flashes, objects]);

  const makeObject = useCallback(
    (node: GNode) => {
      const group =
        node.kind === "engine" ? createEngine(pool, node) : node.kind === "provider" ? createProvider(pool, node) : createModel(pool, node);
      const anim = group.userData.anim as NodeAnim;
      if (!motion) anim.scale = 1;
      objects.get(node.id) && disposeNode(objects.get(node.id)!);
      objects.set(node.id, group);
      return group;
    },
    [pool, objects, motion],
  );

  // Container size (the graph needs explicit pixel dimensions).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
    const ro = new ResizeObserver(([entry]) => {
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Physics, lighting, bloom and renderer settings, once the graph exists.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || size.width === 0) return;

    const charge = fg.d3Force("charge") as unknown as { strength: (fn: (n: GNode) => number) => void } | undefined;
    charge?.strength((n) => (n.kind === "engine" ? -250 : n.kind === "provider" ? -70 : -6));
    const link = fg.d3Force("link") as unknown as
      | { distance: (fn: (l: GLink) => number) => { strength: (fn: (l: GLink) => number) => void } }
      | undefined;
    link
      ?.distance((l) => {
        const source = cache.get(endId(l.source));
        const target = cache.get(endId(l.target));
        if (l.kind === "monitor") return 95 + (source?.radius ?? 10) * 2.5;
        if (l.kind === "member") return (source?.radius ?? 10) * 1.6 + (target?.radius ?? 2) * 2 + 6;
        return 18;
      })
      .strength((l) => (l.kind === "monitor" ? 0.5 : l.kind === "member" ? 0.9 : 0.02));
    fg.d3Force(
      "collide",
      forceCollide<GNode>((n) => n.radius * (n.kind === "model" ? 2.2 : 1.6) + 2).iterations(2) as never,
    );

    const renderer = fg.renderer() as THREE.WebGLRenderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

    const scene = fg.scene();
    // Set on the scene (not only the clear color) so it goes through color
    // management with the bloom composer and stays deep navy.
    scene.background = new THREE.Color(BACKGROUND);
    scene.fog = new THREE.FogExp2(BACKGROUND, 0.0011);
    const rim = new THREE.PointLight(new THREE.Color("#cfd8e3"), 1.2, 0, 0);
    const fill = new THREE.DirectionalLight(new THREE.Color("#8b95a7"), 0.5);
    fill.position.set(-300, 200, -200);
    scene.add(rim, fill);

    const composer = fg.postProcessingComposer();
    // Soft bloom: only bright cores and particles glow, the background stays dark.
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.width, size.height), 0.16, 0.3, 0.75);
    composer.addPass(bloom);

    return () => {
      scene.remove(rim, fill);
      rim.dispose();
      fill.dispose();
      composer.removePass(bloom);
      bloom.dispose();
    };
    // Size changes only matter for the first setup; the composer tracks resizes itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width > 0 && fontReady]);

  // One animation loop for all nodes (scale easing, idle float, pulses).
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = now / 1000;
      for (const group of objects.values()) {
        animateNode(group.userData.anim as NodeAnim, t, dt, motion);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [objects, motion]);

  // Free GPU resources when the view goes away. Deferred so React's StrictMode
  // mount → unmount → mount check (dev) doesn't dispose a pool still in use.
  const disposeTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(disposeTimer.current);
    return () => {
      disposeTimer.current = window.setTimeout(() => {
        objects.forEach(disposeNode);
        objects.clear();
        pool.dispose();
      }, 0);
    };
  }, [objects, pool]);

  // Pause rendering while the tab is hidden.
  useEffect(() => {
    const onVis = () => {
      const fg = fgRef.current;
      if (!fg) return;
      if (document.hidden) fg.pauseAnimation();
      else fg.resumeAnimation();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const focus = useCallback((node: GNode, ms = 1200) => {
    const fg = fgRef.current;
    if (!fg || node.x === undefined) return;
    fitted.current = true; // the user picked a view: no automatic re-framing after this
    const target = new THREE.Vector3(node.x, node.y ?? 0, node.z ?? 0);
    // Look at the node from outside the network, a little above, so the core
    // isn't right behind it.
    const dir = target.lengthSq() > 1 ? target.clone().normalize() : new THREE.Vector3(0, 0, 1);
    dir.add(new THREE.Vector3(0, 0.45, 0)).normalize();
    const distance = node.kind === "engine" ? 260 : 110 + node.radius * 12;
    const pos = target.clone().addScaledVector(dir, distance);
    fg.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: target.x, y: target.y, z: target.z }, ms);
  }, []);

  const resetCamera = useCallback(() => {
    fitted.current = true;
    fgRef.current?.zoomToFit(1000, 40);
  }, []);

  // Frame the network once the layout has spread out. Fitting too early (nodes
  // still bunched at the origin) would put the camera inside the core's glow.
  const fitWhenSpread = useCallback((ms: number) => {
    const fg = fgRef.current;
    const box = fg?.getGraphBbox();
    if (!fg || !box) return false;
    const extent = Math.max(box.x[1] - box.x[0], box.y[1] - box.y[0], box.z[1] - box.z[0]);
    if (!Number.isFinite(extent) || extent < MIN_FIT_EXTENT) return false;
    fg.zoomToFit(ms, 40);
    return true;
  }, []);

  const hasNodes = graph.nodes.length > 1;
  useEffect(() => {
    if (!hasNodes || fitted.current) return;
    let tries = 0;
    let id: number;
    const attempt = () => {
      if (fitted.current || fitWhenSpread(800) || ++tries > 20) return;
      id = window.setTimeout(attempt, 750);
    };
    id = window.setTimeout(attempt, 1200);
    return () => window.clearTimeout(id);
  }, [hasNodes, fitWhenSpread]);
  useImperativeHandle(ref, () => ({ resetCamera }), [resetCamera]);

  // Selecting a model (here or from the side lists) flies the camera to it.
  useEffect(() => {
    if (!selectedId) return;
    const node = cache.get(selectedId);
    if (node) focus(node);
  }, [selectedId, cache, focus]);

  // Hover state on the node objects, plus the pointer cursor.
  useEffect(() => {
    for (const group of objects.values()) {
      (group.userData.anim as NodeAnim).hovered = false;
    }
    if (hovered) {
      const anim = objects.get(hovered.id)?.userData.anim as NodeAnim | undefined;
      if (anim) anim.hovered = true;
    }
    if (containerRef.current) containerRef.current.style.cursor = hovered ? "pointer" : "grab";
  }, [hovered, objects]);

  // Link ends are ids until the simulation swaps in the node objects.
  const end = useCallback((x: string | GNode) => (typeof x === "object" ? x : cache.get(x)), [cache]);
  const endId = (x: string | GNode) => (typeof x === "object" ? x.id : x);
  const linkStatusColor = useCallback((l: GLink) => STATUS[end(l.source)?.status ?? "unknown"].color, [end]);

  const isLit = useCallback(
    (l: GLink) => {
      if (!hovered && !selectedId) return false;
      const ids = [endId(l.source), endId(l.target)];
      return (hovered && ids.includes(hovered.id)) || (selectedId !== null && ids.includes(selectedId));
    },
    [hovered, selectedId],
  );

  return (
    <div ref={containerRef} className="absolute inset-0" style={{ background: BACKGROUND }}>
      {size.width > 0 && fontReady && (
        <ForceGraph3D<GNode, GLink>
          ref={fgRef}
          width={size.width}
          height={size.height}
          graphData={graph}
          backgroundColor={BACKGROUND}
          showNavInfo={false}
          controlType="orbit"
          nodeThreeObject={makeObject}
          nodeLabel={tooltip}
          nodeVal={(n) => n.radius}
          onNodeHover={(n) => setHovered(n ?? null)}
          onNodeClick={(n) => {
            if (n.kind === "model") onSelect(n.id);
            else if (n.kind === "engine") resetCamera();
            else focus(n);
          }}
          onNodeDragEnd={(n) => {
            // Let dragged nodes settle back into the layout instead of pinning them.
            if (n.kind !== "engine") {
              n.fx = undefined;
              n.fy = undefined;
              n.fz = undefined;
            }
          }}
          linkSource="source"
          linkTarget="target"
          linkColor={(l) =>
            isLit(l)
              ? "#cbd5e1"
              : l.kind === "monitor"
                ? linkStatusColor(l)
                : l.kind === "lineage"
                  ? "#6f7396"
                  : "#262c36"
          }
          linkOpacity={0.22}
          linkWidth={(l) => (l.kind === "monitor" ? (isLit(l) ? 0.6 : 0.3) : 0)}
          linkDirectionalParticles={(l) => (motion && l.kind === "monitor" ? l.particles : 0)}
          linkDirectionalParticleSpeed={0.0025}
          linkDirectionalParticleWidth={1}
          linkDirectionalParticleColor={linkStatusColor}
          linkDirectionalParticleResolution={6}
          d3AlphaDecay={0.025}
          d3VelocityDecay={0.38}
          warmupTicks={60}
          cooldownTicks={250}
          onEngineStop={() => {
            if (!fitted.current && fitWhenSpread(900)) fitted.current = true;
          }}
        />
      )}
    </div>
  );
});

export default Network3D;
