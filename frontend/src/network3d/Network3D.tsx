import { forceCollide } from "d3-force-3d";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods } from "react-force-graph-3d";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { fmt, STATUS, THEME } from "../format";
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
  setFocus,
  setStatus,
  setStreamColor,
  setStreamState,
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
  /** Back to the global view (clear the selection). */
  onClear: () => void;
  reducedMotion: boolean;
}

const BACKGROUND = THEME.background;
/** Smallest network size (scene units) worth framing; below it the layout hasn't spread yet. */
const MIN_FIT_EXTENT = 900;
const MAX_PIXEL_RATIO = 1.25;
/** A press and release this close together (px) is a click, not a camera drag. */
const CLICK_TOLERANCE = 6;
/** Below this frame rate (measured over 2 s) the view steps its quality down. */
const MIN_FPS = 40;

/** Small deterministic jitter from an id, so the layout is the same on every load. */
function hash01(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Where each provider settles: a "galactic disc" facing the default camera.
 * Providers follow a sunflower spiral over an annulus around the core (biggest
 * nearest the center), with a little depth for relief. Unlike a sphere, nothing
 * sits in front of or behind the core, so clusters stay separate on screen.
 */
function providerAnchors(nodes: GNode[]): Map<string, THREE.Vector3> {
  const providers = nodes.filter((n) => n.kind === "provider").sort((a, b) => b.volume - a.volume);
  const anchors = new Map<string, THREE.Vector3>();
  const golden = Math.PI * (3 - Math.sqrt(5));
  const inner = 620;
  const outer = 620 + 120 * Math.sqrt(providers.length);
  providers.forEach((p, i) => {
    const r = inner + (outer - inner) * Math.sqrt((i + 0.5) / providers.length);
    const a = i * golden;
    const depth = (hash01(p.id) - 0.5) * 320;
    anchors.set(p.id, new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, depth));
  });
  return anchors;
}

/**
 * Soft spatial structure (a d3 force): providers ease toward their anchor; models
 * ease toward a point just outside their provider, so each family forms a petal
 * pointing away from the core. Organic, not a grid: the other forces still apply.
 */
function clusterForce(cache: Map<string, GNode>, anchors: { current: Map<string, THREE.Vector3> }) {
  let nodes: GNode[] = [];
  const family = new Map<string, number>();
  const force = (alpha: number) => {
    for (const n of nodes) {
      if (n.x === undefined || n.y === undefined || n.z === undefined) continue;
      if (n.kind === "provider") {
        const a = anchors.current.get(n.id);
        if (!a) continue;
        const k = 0.05 * alpha;
        n.vx = (n.vx ?? 0) + (a.x - n.x) * k;
        n.vy = (n.vy ?? 0) + (a.y - n.y) * k;
        n.vz = (n.vz ?? 0) + (a.z - n.z) * k;
      } else if (n.kind === "model") {
        const p = cache.get(`provider:${n.provider}`);
        if (!p || p.x === undefined || p.y === undefined || p.z === undefined) continue;
        const len = Math.hypot(p.x, p.y, p.z) || 1;
        const out = p.radius * 1.6 + 90 + Math.sqrt(family.get(n.provider!) ?? 1) * 22;
        const k = 0.025 * alpha;
        n.vx = (n.vx ?? 0) + (p.x + (p.x / len) * out - n.x) * k;
        n.vy = (n.vy ?? 0) + (p.y + (p.y / len) * out - n.y) * k;
        n.vz = (n.vz ?? 0) + (p.z + (p.z / len) * out - n.z) * k;
      }
    }
  };
  force.initialize = (ns: GNode[]) => {
    nodes = ns;
    family.clear();
    for (const n of ns) if (n.kind === "model") family.set(n.provider!, (family.get(n.provider!) ?? 0) + 1);
  };
  return force;
}

// Thin connection lines: secondary ones barely visible (5-15 %), turquoise when in focus.
const LINE = {
  member: { color: THEME.blue, opacity: 0.07 },
  lineage: { color: THEME.violet, opacity: 0.08 },
  lit: { color: THEME.teal, opacity: 0.6 },
  dim: 0.02,
};

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
  { models, providers, selectedId, flashes, onSelect, onClear, reducedMotion },
  ref,
) {
  const fgRef = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Hover is tracked in a ref, not state: re-rendering on every hover made the graph
  // re-process all nodes and links, which is what made camera moves stutter.
  const hoveredRef = useRef<GNode | null>(null);
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
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const bloomRef = useRef<UnrealBloomPass | null>(null);
  const composerRef = useRef<{ setPixelRatio: (r: number) => void } | null>(null);
  // Adaptive quality: 0 = full; each step down trades looks for frame rate on slower machines.
  const quality = useRef(0);
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

  // Provider anchors and direct relations, recomputed only when the structure changes.
  const anchors = useRef(new Map<string, THREE.Vector3>());
  anchors.current = useMemo(() => providerAnchors(graph.nodes), [graph]);
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (a: string, b: string) => map.set(a, (map.get(a) ?? new Set()).add(b));
    for (const l of graph.links) {
      if (l.kind === "monitor") continue; // everything talks to the core; that's not a "direct" relation
      const a = typeof l.source === "object" ? l.source.id : l.source;
      const b = typeof l.target === "object" ? l.target.id : l.target;
      add(a, b);
      add(b, a);
    }
    return map;
  }, [graph]);

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
      setStreamColor(mesh, STATUS[cache.get(endId(link.source))?.status ?? "unknown"].color);
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

    // Layout: providers are softly anchored on a sphere around the core (spread
    // evenly, biggest first), and each provider's models gather on its outer side,
    // so families read as clusters and their links don't cross the center.
    const charge = fg.d3Force("charge") as unknown as
      | { strength: (fn: (n: GNode) => number) => { distanceMax: (d: number) => void } }
      | undefined;
    charge?.strength((n) => (n.kind === "engine" ? -300 : n.kind === "provider" ? -520 : -70)).distanceMax(1400);
    const link = fg.d3Force("link") as unknown as
      | { distance: (fn: (l: GLink) => number) => { strength: (fn: (l: GLink) => number) => void } }
      | undefined;
    link
      ?.distance((l) => {
        const source = cache.get(endId(l.source));
        const target = cache.get(endId(l.target));
        if (l.kind === "member") return (source?.radius ?? 47) * 1.5 + (target?.radius ?? 15) * 2 + 70;
        if (l.kind === "lineage") return 60;
        return 1000;
      })
      .strength((l) => {
        if (l.kind === "member") return 0.55;
        if (l.kind === "lineage") return 0.01;
        return 0; // streams to the core are drawn, not pulled: the anchor force places providers
      });
    fg.d3Force("cluster", clusterForce(cache, anchors) as never);
    fg.d3Force("collide", forceCollide<GNode>((n) => n.radius * 1.45 + 14).iterations(3) as never);

    const renderer = fg.renderer() as THREE.WebGLRenderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    rendererRef.current = renderer;

    // Deep-space background, star field and core dust, plus bloom so every light glows.
    const scene = fg.scene();
    scene.background = new THREE.Color(BACKGROUND);
    scene.fog = new THREE.FogExp2(BACKGROUND, 0.00014);
    const space = createSpace();
    spaceRef.current = space;
    scene.add(space.group);

    const composer = fg.postProcessingComposer();
    // Gentle bloom: only the brightest highlights glow; logos and the core stay legible.
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.width, size.height), 0.7, 0.5, 0.72);
    composer.addPass(bloom);
    bloomRef.current = bloom;
    composerRef.current = composer;
    quality.current = 0;

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
    let frames = 0;
    let windowStart = performance.now();
    let slowWindows = 0;
    const stepQualityDown = () => {
      const level = ++quality.current;
      if (level === 1) {
        rendererRef.current?.setPixelRatio(1);
        composerRef.current?.setPixelRatio(1);
      } else if (level === 2 && bloomRef.current) {
        bloomRef.current.enabled = false;
      } else if (level === 3 && spaceRef.current) {
        spaceRef.current.group.visible = false;
      }
    };
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // Measure the frame rate every 2 s; two slow windows in a row lower the quality one step.
      frames++;
      if (now - windowStart > 2000) {
        const fps = (frames * 1000) / (now - windowStart);
        slowWindows = fps < MIN_FPS && !document.hidden ? slowWindows + 1 : 0;
        if (slowWindows >= 2 && quality.current < 3) {
          stepQualityDown();
          slowWindows = 0;
        }
        frames = 0;
        windowStart = now;
      }
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
    // The layout is a disc facing the default camera: approach from the front so
    // the cluster keeps its context and labels sit under their logos.
    const dir = new THREE.Vector3(0, 0, 1);
    const distance = node.kind === "engine" ? 900 : 260 + node.radius * 14;
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

  // Back to the global view: clear the focus and frame the whole network.
  const resetCamera = useCallback(() => {
    fitted.current = true;
    onClearRef.current();
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

  // Link ends are ids until the simulation swaps in the node objects.
  const end = useCallback((x: string | GNode) => (typeof x === "object" ? x : cache.get(x)), [cache]);
  const endId = (x: string | GNode) => (typeof x === "object" ? x.id : x);

  // Focus: the hovered node (or else the selected one) and its direct relations stay
  // bright, their links turn turquoise, everything else fades. Only material and
  // uniform changes: no React render, no graph re-processing.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const lines = useRef(new Map<string, { m: THREE.LineBasicMaterial; link: GLink }>()).current;
  const refreshHighlight = useCallback(() => {
    const focusId = hoveredRef.current?.id ?? selectedRef.current;
    const active = !!focusId && focusId !== ENGINE_ID && cache.has(focusId);
    const related = new Set<string>(active ? [focusId!, ...(neighbors.get(focusId!) ?? [])] : []);
    for (const [id, group] of objects) {
      const anim = group.userData.anim as NodeAnim;
      if (id === ENGINE_ID) continue;
      setFocus(anim, !active || related.has(id), active && related.has(id));
    }
    for (const { mesh, link } of flows.values()) {
      setStreamState(mesh, !active ? "normal" : related.has(endId(link.source)) ? "lit" : "dim");
    }
    for (const { m, link } of lines.values()) {
      const a = endId(link.source);
      const b = endId(link.target);
      const lit = active && (a === focusId || b === focusId);
      const style = lit ? LINE.lit : LINE[link.kind === "lineage" ? "lineage" : "member"];
      m.color.set(style.color);
      m.opacity = lit ? LINE.lit.opacity : active ? LINE.dim : style.opacity;
    }
  }, [flows, lines, objects, cache, neighbors]);
  useEffect(refreshHighlight, [selectedId, refreshHighlight]);

  const onHover = useCallback(
    (n: GNode | null) => {
      const before = hoveredRef.current;
      if (before === n) return;
      if (before) {
        const anim = objects.get(before.id)?.userData.anim as NodeAnim | undefined;
        if (anim) anim.hovered = false;
      }
      if (n) {
        const anim = objects.get(n.id)?.userData.anim as NodeAnim | undefined;
        if (anim) anim.hovered = true;
      }
      hoveredRef.current = n;
      if (containerRef.current) containerRef.current.style.cursor = n ? "pointer" : "grab";
      refreshHighlight();
    },
    [objects, refreshHighlight],
  );

  // Every callback handed to the graph keeps a stable identity: a new function on a
  // prop like nodeVal or linkColor makes the library re-process every node or link.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onClearRef = useRef(onClear);
  onClearRef.current = onClear;
  const nodeVal = useCallback((n: GNode) => n.radius, []);
  // One material per line (cached by link id) so focus can light or dim each line in place.
  const linkMaterial = useCallback(
    (l: GLink) => {
      if (l.kind === "monitor") return null as unknown as THREE.Material;
      const cached = lines.get(l.id);
      if (cached) {
        cached.link = l;
        return cached.m;
      }
      const style = LINE[l.kind === "lineage" ? "lineage" : "member"];
      const m = pool.own(
        new THREE.LineBasicMaterial({
          color: style.color,
          transparent: true,
          opacity: style.opacity,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      lines.set(l.id, { m, link: l });
      return m;
    },
    [lines, pool],
  );
  const onClick = useCallback(
    (n: GNode) => {
      // Models and providers open their details panel (and the camera flies to them).
      if (n.kind === "engine") resetCamera();
      else onSelectRef.current(n.id);
    },
    [resetCamera],
  );
  // Node dragging is off: a press that moved a few pixels used to grab the node and
  // re-heat the whole layout, which felt like a bug when you just meant to click.

  // Our own click detection: the library drops a click as soon as the mouse moves
  // by a single pixel while pressed, so real-world clicks were often lost.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // The node under the pointer is captured on press: as soon as the mouse moves
    // while pressed, the library treats it as a camera drag and reports "no hover",
    // so reading the hover on release would mistake a shaky click for empty space.
    let down: { x: number; y: number; node: GNode | null } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY, node: hoveredRef.current };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || e.button !== 0) return;
      const { x, y, node } = down;
      down = null;
      if (Math.hypot(e.clientX - x, e.clientY - y) > CLICK_TOLERANCE) return;
      if (node) onClick(node);
      else onClearRef.current(); // a click in empty space returns to the global view
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [onClick]);
  const onEngineStop = useCallback(() => {
    if (!fitted.current && fitWhenSpread(900)) fitted.current = true;
  }, [fitWhenSpread]);

  // Every node → core link is a stream of light pulses (thicker and faster for busier
  // nodes, providers more than models); the other links stay thin lines.
  // Must keep a stable identity: a new function makes the graph rebuild every link.
  const makeLink = useCallback(
    (l: GLink) => {
      if (l.kind !== "monitor") return null as unknown as THREE.Object3D;
      const status = end(l.source)?.status ?? "unknown";
      const provider = end(l.source)?.kind === "provider";
      // Importance shows in width and brightness: provider streams are the main
      // connections, model streams stay faint (5-15 %) until they're in focus.
      const width = provider ? 0.5 + 0.9 * l.activity : 0.15 + 0.25 * l.activity;
      const rate = provider ? 0.1 + 0.16 * l.activity : 0.05 + 0.11 * l.activity; // trains per second
      const opacity = provider ? 0.22 + 0.22 * l.activity : 0.05 + 0.1 * l.activity;
      const mesh = createStream(pool, STATUS[status].color, width, rate, Math.random(), opacity);
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
          nodeVal={nodeVal}
          onNodeHover={onHover}
          enableNodeDrag={false}
          linkSource="source"
          linkTarget="target"
          linkThreeObject={makeLink}
          linkPositionUpdate={positionLink}
          linkMaterial={linkMaterial}
          linkWidth={0}
          d3AlphaDecay={0.025}
          d3VelocityDecay={0.38}
          warmupTicks={60}
          cooldownTicks={250}
          onEngineStop={onEngineStop}

        />
      )}
    </div>
  );
});

// Memoized: the page re-renders every 30 s for its "x min ago" labels; the 3D view needn't.
export default memo(Network3D);
