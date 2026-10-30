import * as THREE from "three";
import SpriteText from "three-spritetext";
import { STATUS } from "../format";
import type { ModelStatus } from "../types";
import type { GNode } from "./graphData";

/**
 * Three.js objects for the 3D network.
 *
 * Every node is a Group whose `body` child holds the visuals: the force
 * simulation moves the Group, the animation loop scales and floats the body.
 * Geometries, materials and textures are shared through a ResourcePool and
 * disposed together when the view unmounts.
 */

export interface NodeAnim {
  body: THREE.Group;
  kind: GNode["kind"];
  /** Animated scale factor, eased toward `target` (0 → 1 when a node appears). */
  scale: number;
  target: number;
  radius: number;
  phase: number;
  hovered: boolean;
  /** Short pulse after a metrics/status update, in seconds remaining. */
  pulse: number;
  status: ModelStatus;
  halo?: THREE.Sprite;
  core?: THREE.Mesh;
  shell?: THREE.Mesh;
  animate?: (t: number, motion: boolean) => void;
}

const ACCENT = new THREE.Color("#7fa7bd");

function circleCanvas(size: number) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.closePath();
  return { canvas, ctx };
}

export class ResourcePool {
  readonly sphere = new THREE.SphereGeometry(1, 40, 28);
  readonly shellGeo = new THREE.IcosahedronGeometry(1.18, 2);
  readonly ringGeo = new THREE.TorusGeometry(1.55, 0.012, 8, 160);
  readonly glow: THREE.CanvasTexture;
  private materials = new Map<string, THREE.Material>();
  private logos = new Map<string, THREE.Texture>();
  private labels = new Set<SpriteText>();
  private disposed = false;

  constructor() {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.25, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    this.glow = new THREE.CanvasTexture(canvas);
    this.glow.colorSpace = THREE.SRGBColorSpace;
  }

  material<T extends THREE.Material>(key: string, make: () => T): T {
    let m = this.materials.get(key);
    if (!m) {
      m = make();
      this.materials.set(key, m);
    }
    return m as T;
  }

  statusColor(status: ModelStatus): THREE.Color {
    return new THREE.Color(STATUS[status].color);
  }

  haloMaterial(status: ModelStatus, opacity: number): THREE.SpriteMaterial {
    return this.material(`halo:${status}:${opacity}`, () =>
      new THREE.SpriteMaterial({
        map: this.glow,
        color: this.statusColor(status),
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
  }

  modelMaterial(status: ModelStatus): THREE.MeshStandardMaterial {
    return this.material(`model:${status}`, () => {
      const c = this.statusColor(status);
      return new THREE.MeshStandardMaterial({
        color: c,
        emissive: c,
        emissiveIntensity: status === "unknown" ? 0.03 : 0.1,
        roughness: 0.55,
        metalness: 0.1,
      });
    });
  }

  providerShell(status: ModelStatus): THREE.MeshPhysicalMaterial {
    return this.material(`provider:${status}`, () =>
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color("#141922"),
        emissive: this.statusColor(status),
        emissiveIntensity: 0.05,
        roughness: 0.15,
        metalness: 0.2,
        clearcoat: 1,
        clearcoatRoughness: 0.2,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      }),
    );
  }

  /** Provider logo clipped to a disc; initials when there is no logo or it fails to load. */
  logo(provider: string, url: string | null | undefined): THREE.Texture {
    const key = `${provider}|${url ?? ""}`;
    const cached = this.logos.get(key);
    if (cached) return cached;

    const size = 256;
    const { canvas, ctx } = circleCanvas(size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.logos.set(key, texture);

    const drawInitials = () => {
      ctx.save();
      ctx.fillStyle = "#1a1f27";
      ctx.fill();
      ctx.fillStyle = "#c9d1db";
      ctx.font = `600 ${size * 0.34}px "Inter Variable", Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const initials = provider.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
      ctx.fillText(initials, size / 2, size / 2 + size * 0.02);
      ctx.restore();
      texture.needsUpdate = true;
    };

    drawInitials();
    if (url) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => {
        if (this.disposed) return;
        ctx.save();
        ctx.clip();
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size, size);
        // Keep the logo's proportions, centered in the disc.
        const scale = Math.min(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        ctx.restore();
        texture.needsUpdate = true;
      };
      img.src = url;
    }
    return texture;
  }

  label(text: string, height: number, color = "#9aa4b2"): SpriteText {
    const s = new SpriteText(text, height, color);
    s.fontFace = '"Inter Variable", Inter, system-ui, sans-serif';
    s.fontWeight = "500";
    s.backgroundColor = false;
    s.padding = 0;
    s.material.depthWrite = false;
    this.labels.add(s);
    return s;
  }

  dispose() {
    this.disposed = true;
    this.sphere.dispose();
    this.shellGeo.dispose();
    this.ringGeo.dispose();
    this.glow.dispose();
    this.materials.forEach((m) => m.dispose());
    this.logos.forEach((t) => t.dispose());
    this.labels.forEach((l) => {
      l.material.map?.dispose();
      l.material.dispose();
      l.geometry.dispose();
    });
    this.materials.clear();
    this.logos.clear();
    this.labels.clear();
  }
}

/** Halos stay faint; only security incidents keep a visible glow so they stand out. */
function haloOpacity(kind: GNode["kind"], status: ModelStatus): number {
  if (status === "security_incident") return 0.22;
  return kind === "provider" ? 0.07 : 0.05;
}

function baseAnim(kind: GNode["kind"], node: GNode, body: THREE.Group): NodeAnim {
  return {
    body,
    kind,
    scale: 0,
    target: 1,
    radius: node.radius,
    phase: Math.random() * Math.PI * 2,
    hovered: false,
    pulse: 0,
    status: node.status,
  };
}

export function createEngine(pool: ResourcePool, node: GNode): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const core = new THREE.Mesh(
    pool.sphere,
    pool.material("engine:core", () =>
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color("#121a24"),
        emissive: ACCENT,
        emissiveIntensity: 0.12,
        roughness: 0.1,
        metalness: 0.1,
        clearcoat: 1,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      }),
    ),
  );
  const heart = new THREE.Mesh(
    pool.sphere,
    pool.material("engine:heart", () => new THREE.MeshBasicMaterial({ color: new THREE.Color("#9cc3d1") })),
  );
  heart.scale.setScalar(0.22);
  const shell = new THREE.Mesh(
    pool.shellGeo,
    pool.material("engine:shell", () =>
      new THREE.MeshBasicMaterial({ color: new THREE.Color("#8aa9bd"), wireframe: true, transparent: true, opacity: 0.06 }),
    ),
  );
  const ringA = new THREE.Mesh(
    pool.ringGeo,
    pool.material("engine:ringA", () =>
      new THREE.MeshBasicMaterial({ color: new THREE.Color("#8aa9bd"), transparent: true, opacity: 0.22 }),
    ),
  );
  const ringB = new THREE.Mesh(
    pool.ringGeo,
    pool.material("engine:ringB", () =>
      new THREE.MeshBasicMaterial({ color: new THREE.Color("#8f8fb8"), transparent: true, opacity: 0.14 }),
    ),
  );
  ringA.rotation.x = Math.PI / 2.4;
  ringB.rotation.x = Math.PI / 1.7;
  ringB.rotation.y = Math.PI / 5;
  ringB.scale.setScalar(1.12);
  const halo = new THREE.Sprite(
    pool.material("engine:halo", () =>
    new THREE.SpriteMaterial({
      map: pool.glow,
      color: ACCENT,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    ),
  );
  halo.scale.setScalar(2.8);
  const label = pool.label("LIVE ANALYSIS CORE", 0.16, "#94a3b8");
  label.position.y = -2.05;

  body.add(halo, core, heart, shell, ringA, ringB, label);

  const anim = baseAnim("engine", node, body);
  anim.animate = (t, motion) => {
    if (!motion) return;
    const breathe = 1 + 0.035 * Math.sin(t * 1.3);
    core.scale.setScalar(breathe);
    heart.scale.setScalar(0.22 + 0.02 * Math.sin(t * 2.1));
    shell.rotation.y = t * 0.08;
    shell.rotation.x = t * 0.03;
    ringA.rotation.z = t * 0.25;
    ringB.rotation.z = -t * 0.18;
    (halo.material as THREE.SpriteMaterial).opacity = 0.07 + 0.02 * Math.sin(t * 1.3);
  };
  group.userData.anim = anim;
  return group;
}

export function createProvider(pool: ResourcePool, node: GNode): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const logo = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: pool.logo(node.name, node.avatar), transparent: true, depthWrite: false }),
  );
  logo.scale.setScalar(1.2);
  logo.renderOrder = 1;
  const shell = new THREE.Mesh(pool.sphere, pool.providerShell(node.status));
  shell.renderOrder = 2;
  const halo = new THREE.Sprite(pool.haloMaterial(node.status, haloOpacity("provider", node.status)));
  halo.scale.setScalar(2.5);
  const label = pool.label(node.name, 0.34);
  label.position.y = -1.6;

  body.add(halo, logo, shell, label);
  const anim = baseAnim("provider", node, body);
  anim.halo = halo;
  anim.shell = shell;
  // The logo material isn't pooled (one per provider): dispose it with the node.
  group.userData.dispose = () => logo.material.dispose();
  group.userData.anim = anim;
  return group;
}

export function createModel(pool: ResourcePool, node: GNode): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const core = new THREE.Mesh(pool.sphere, pool.modelMaterial(node.status));
  const halo = new THREE.Sprite(pool.haloMaterial(node.status, haloOpacity("model", node.status)));
  halo.scale.setScalar(2.4);
  body.add(halo, core);
  const anim = baseAnim("model", node, body);
  anim.halo = halo;
  anim.core = core;
  group.userData.anim = anim;
  return group;
}

/** Applies a status change to an existing node's materials. */
export function setStatus(pool: ResourcePool, anim: NodeAnim, status: ModelStatus) {
  if (anim.status === status) return;
  anim.status = status;
  if (anim.halo) anim.halo.material = pool.haloMaterial(status, haloOpacity(anim.kind, status));
  if (anim.core) anim.core.material = pool.modelMaterial(status);
  if (anim.shell) anim.shell.material = pool.providerShell(status);
}

/** One frame of node animation: eased size, idle float, hover and update pulses. */
export function animateNode(anim: NodeAnim, t: number, dt: number, motion: boolean) {
  const hover = anim.hovered ? 1.18 : 1;
  anim.pulse = Math.max(0, anim.pulse - dt);
  const pulse = anim.pulse > 0 ? 1 + 0.25 * Math.sin((anim.pulse / 1.2) * Math.PI) : 1;
  const goal = anim.target * hover * pulse;
  anim.scale = motion ? anim.scale + (goal - anim.scale) * Math.min(1, dt * 5) : goal;
  anim.body.scale.setScalar(Math.max(0.0001, anim.scale * anim.radius));

  if (motion && anim.kind !== "engine") {
    const amp = anim.kind === "provider" ? 1.2 : 0.6;
    anim.body.position.y = Math.sin(t * 0.6 + anim.phase) * amp;
    anim.body.position.x = Math.cos(t * 0.45 + anim.phase) * amp * 0.5;
  } else {
    anim.body.position.set(0, 0, 0);
  }

  // Security incidents keep a slow violet throb so they stand out.
  if (anim.halo && anim.status === "security_incident") {
    const s = 2.6 + (motion ? 0.7 * (0.5 + 0.5 * Math.sin(t * 3)) : 0.3);
    anim.halo.scale.setScalar(s);
  }
  anim.animate?.(t, motion);
}

export function disposeNode(group: THREE.Object3D) {
  (group.userData.dispose as (() => void) | undefined)?.();
}
