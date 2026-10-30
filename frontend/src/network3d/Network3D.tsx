import { forceCollide } from "d3-force-3d";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods } from "react-force-graph-3d";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { fmt, STATUS } from "../format";
import type { AIModel, Providers } from "../types";
import { buildGraph, ENGINE_ID, ENGINE_RADIUS, structureKey, type GLink, type GNode } from "./graphData";
import {
  animateNode,
  createEngine,
  createModel,
  createProvider,
  createStream,
  disposeNode,
  kick,
  placeStream,
  pulseHead,
  ResourcePool,
  STREAM_OPACITY,
  STREAM_OPACITY_LIT,
  setStatus,
  type NodeAnim,
} from "./objects";
import { createSpace } from "./space";

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

const BACKGROUND = "#02030a";
/** Smallest network size (scene units) worth framing; below it the layout hasn't spread yet. */
const MIN_FIT_EXTENT = 900;

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
  const flows = useRef(new Map<string, { mesh: THREE.Mesh; link: GLink; head: number }>()).current;
  const fitted = useRef(false);
  const spaceRef = useRef<ReturnType<typeof createSpace> | null>(null);
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
    for (const { mesh, link } of flows.values()) {
      const status = cache.get(endId(link.source))?.status ?? "unknown";
      ((mesh.material as THREE.ShaderMaterial).uniforms.uColor.value as THREE.Color).set(STATUS[status].color);
    }
  }, [models, providers, cache, objects, flows, pool]);

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
    charge?.strength((n) => (n.kind === "engine" ? -2400 : n.kind === "provider" ? -900 : -160));
    const link = fg.d3Force("link") as unknown as
      | { distance: (fn: (l: GLink) => number) => { strength: (fn: (l: GLink) => number) => void } }
      | undefined;
    link
      ?.distance((l) => {
        const source = cache.get(endId(l.source));
        const target = cache.get(endId(l.target));
        if (l.kind === "monitor") return source?.kind === "model" ? 1200 : 680 + (source?.radius ?? 42) * 4;
        if (l.kind === "member") return (source?.radius ?? 42) * 2.4 + (target?.radius ?? 18) * 3.2 + 110;
        return 18;
      })
      .strength((l) => {
        if (l.kind === "member") return 0.9;
        if (l.kind === "lineage") return 0.02;
        // Model streams barely pull, so models stay grouped around their provider.
        return cache.get(endId(l.source))?.kind === "model" ? 0.02 : 0.5;
      });
    fg.d3Force(
      "collide",
      forceCollide<GNode>((n) => n.radius * (n.kind === "model" ? 2.3 : 2.1) + 40).iterations(3) as never,
    );

    const renderer = fg.renderer() as THREE.WebGLRenderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

    // Deep-space background, star field and core dust, plus bloom so every light glows.
    const scene = fg.scene();
    scene.background = new THREE.Color(BACKGROUND);
    scene.fog = new THREE.FogExp2(BACKGROUND, 0.00013);
    const space = createSpace();
    spaceRef.current = space;
    scene.add(space.group);

    const composer = fg.postProcessingComposer();
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.width, size.height), 1.1, 0.6, 0.6);
    composer.addPass(bloom);

    return () => {
      scene.remove(space.group);
      space.dispose();
      spaceRef.current = null;
      composer.removePass(bloom);
      bloom.dispose();
    };
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
      if (motion) {
        pool.time.value = t;
        spaceRef.current?.update(t);
        // A pulse leaves its node when the head wraps around; that same instant the
        // previous one reaches the core. The node wobbles, the core gains energy.
        const core = objects.get(ENGINE_ID)?.userData.receive as ((n: number) => void) | undefined;
        for (const flow of flows.values()) {
          const head = pulseHead(t, flow.mesh.userData.rate, flow.mesh.userData.phase);
          const group = objects.get(endId(flow.link.source));
          const source = group?.userData.anim as NodeAnim | undefined;
          const fromProvider = source?.kind === "provider";
          if (head < flow.head) {
            if (source) kick(source, fromProvider ? 0.9 : 0.7);
            core?.(fromProvider ? 0.08 : 0.025);
          }
          if (source && group) {
            // Pulled toward the core as the train rolls out, released as it arrives.
            const s = Math.sin(Math.PI * head);
            source.pull = s * s;
            source.pullDir.copy(group.position).multiplyScalar(-1).normalize();
          }
          flow.head = head;
        }
      }
      for (const group of objects.values()) {
        animateNode(group.userData.anim as NodeAnim, t, dt, motion);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [objects, flows, motion, pool]);

  // Free GPU resources when the view goes away. Deferred so React's StrictMode
  // mount → unmount → mount check (dev) doesn't dispose a pool still in use.
  const disposeTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(disposeTimer.current);
    return () => {
      disposeTimer.current = window.setTimeout(() => {
        objects.forEach(disposeNode);
        objects.clear();
        flows.clear();
        pool.dispose();
      }, 0);
    };
  }, [objects, flows, pool]);

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

  /**
   * Frames the whole network so it fills the view. The library's zoomToFit fits
   * the 3D bounding box (depth included) and leaves a lot of empty space; this
   * fits the network's radius to the field of view instead.
   */
  const frame = useCallback((ms: number) => {
    const fg = fgRef.current;
    const box = fg?.getGraphBbox();
    if (!fg || !box) return false;
    const center = new THREE.Vector3((box.x[0] + box.x[1]) / 2, (box.y[0] + box.y[1]) / 2, (box.z[0] + box.z[1]) / 2);
    const radius = Math.max(box.x[1] - box.x[0], box.y[1] - box.y[0], box.z[1] - box.z[0]) / 2;
    if (!Number.isFinite(radius) || radius * 2 < MIN_FIT_EXTENT) return false;
    const camera = fg.camera() as THREE.PerspectiveCamera;
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const distance = Math.max(radius / tan, radius / (tan * camera.aspect)) * 1.12;
    const dir = camera.position.clone().sub(center);
    if (dir.lengthSq() < 1) dir.set(0, 0, 1);
    const pos = center.clone().addScaledVector(dir.normalize(), distance);
    fg.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: center.x, y: center.y, z: center.z }, ms);
    return true;
  }, []);

  const resetCamera = useCallback(() => {
    fitted.current = true;
    frame(1000);
  }, [frame]);

  // Frame the network once the layout has spread out. Fitting too early (nodes
  // still bunched at the origin) would put the camera inside the core's glow.
  const fitWhenSpread = frame;

  // Keep re-framing while the layout settles (it first expands, then contracts),
  // until the user takes over the camera.
  const hasNodes = graph.nodes.length > 1;
  useEffect(() => {
    if (!hasNodes || fitted.current) return;
    let tries = 0;
    let id: number;
    const attempt = () => {
      if (fitted.current || ++tries > 12) return;
      fitWhenSpread(700);
      id = window.setTimeout(attempt, 1200);
    };
    id = window.setTimeout(attempt, 1200);
    return () => window.clearTimeout(id);
  }, [hasNodes, fitWhenSpread]);

  // Any rotate / zoom / pan by the user stops the automatic framing.
  useEffect(() => {
    const controls = fgRef.current?.controls() as THREE.EventDispatcher<{ start: object }> | undefined;
    if (!controls) return;
    const stop = () => {
      fitted.current = true;
    };
    controls.addEventListener("start", stop);
    return () => controls.removeEventListener("start", stop);
  }, [size.width > 0 && fontReady]);
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

  const isLit = useCallback(
    (l: GLink) => {
      if (!hovered && !selectedId) return false;
      const ids = [endId(l.source), endId(l.target)];
      return (hovered && ids.includes(hovered.id)) || (selectedId !== null && ids.includes(selectedId));
    },
    [hovered, selectedId],
  );

  // Hovered or selected links get brighter (a uniform change, no rebuild).
  useEffect(() => {
    for (const { mesh, link } of flows.values()) {
      (mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value = isLit(link) ? STREAM_OPACITY_LIT : STREAM_OPACITY;
    }
  }, [isLit, flows]);

  // Every node → core link is a stream of light pulses (thicker and faster for busier
  // nodes, providers more than models); the other links stay thin lines.
  // Must keep a stable identity: a new function makes the graph rebuild every link.
  const makeLink = useCallback(
    (l: GLink) => {
      if (l.kind !== "monitor") return null as unknown as THREE.Object3D;
      const status = end(l.source)?.status ?? "unknown";
      const provider = end(l.source)?.kind === "provider";
      const width = provider ? 0.4 + 0.8 * l.activity : 0.12 + 0.28 * l.activity;
      const rate = provider ? 0.1 + 0.16 * l.activity : 0.05 + 0.11 * l.activity; // trains per second
      const mesh = createStream(pool, STATUS[status].color, width, rate, Math.random());
      const old = flows.get(l.id);
      if (old) (old.mesh.userData.dispose as () => void)();
      flows.set(l.id, { mesh, link: l, head: 0 });
      return mesh;
    },
    [pool, flows, end],
  );

  const positionLink = useCallback(
    // The library types the link loosely here; it's one of our GLinks.
    (obj: THREE.Object3D, coords: { start: THREE.Vector3Like; end: THREE.Vector3Like }, link: object) => {
      const l = link as GLink;
      if (l.kind !== "monitor") return false;
      const sourceRadius = end(l.source)?.radius ?? 10;
      placeStream(obj as THREE.Mesh, coords.start, coords.end, sourceRadius * 1.2, ENGINE_RADIUS * 1.1);
      return true;
    },
    [end],
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
          linkThreeObject={makeLink}
          linkPositionUpdate={positionLink}
          linkColor={(l) => (isLit(l) ? "#e4eeff" : l.kind === "lineage" ? "#b08cff" : "#4c7dff")}
          linkOpacity={0.3}
          linkWidth={0}
          d3AlphaDecay={0.025}
          d3VelocityDecay={0.38}
          warmupTicks={60}
          cooldownTicks={250}
          onEngineStop={() => {
            if (!fitted.current && fitWhenSpread(900)) fitted.current = true;
          }}
          onNodeDrag={() => {
            fitted.current = true;
          }}
        />
      )}
    </div>
  );
});

export default Network3D;
