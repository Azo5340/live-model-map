import * as THREE from "three";
import SpriteText from "three-spritetext";
import { STATUS } from "../format";
import type { ModelStatus } from "../types";
import type { GNode } from "./graphData";

/**
 * Three.js objects for the 3D network: flat, camera-facing badges (no shading,
 * no reflections) and thick provider → core links with a continuous flowing
 * gradient.
 *
 * Every node is a Group whose `body` child holds the visuals: the force
 * simulation moves the Group, the animation loop scales and floats the body.
 * Textures and materials are shared through a ResourcePool and disposed
 * together when the view unmounts.
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
  disc?: THREE.Sprite;
  ring?: THREE.Sprite;
  alert?: THREE.Sprite;
  animate?: (t: number, motion: boolean) => void;
}

const TEX = 256; // canvas size for badge textures
const UP = new THREE.Vector3(0, 1, 0);

function canvas2d() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TEX;
  return { canvas, ctx: canvas.getContext("2d")! };
}

/** Outlines and overlays blend; solid badges write depth so nearer nodes cleanly hide farther ones. */
function spriteMaterial(map: THREE.Texture, opacity = 1, solid = false) {
  return solid
    ? new THREE.SpriteMaterial({ map, transparent: true, alphaTest: 0.5, depthWrite: true })
    : new THREE.SpriteMaterial({ map, transparent: true, opacity, depthWrite: false });
}

const FLOW_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Soft bands sliding along the tube from source (v = 0) to target (v = 1):
// a continuous gradient, no discrete particles.
const FLOW_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSpeed;
  uniform float uRepeat;
  uniform float uOpacity;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float wave = 0.5 + 0.5 * sin(6.2831853 * (vUv.y * uRepeat - uTime * uSpeed));
    float flow = mix(0.62, 1.0, wave * wave * (3.0 - 2.0 * wave));
    float ends = smoothstep(0.0, 0.06, vUv.y) * smoothstep(0.0, 0.06, 1.0 - vUv.y);
    gl_FragColor = vec4(uColor * (0.8 + 0.3 * flow), uOpacity * flow * ends);
  }
`;

export class ResourcePool {
  /** Open tube along +Y, unit height and radius; scaled per link. */
  readonly tube = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
  /** Shared by every flow material so one update per frame animates all links. */
  readonly time = { value: 0 };
  private textures = new Map<string, THREE.Texture>();
  private materials = new Map<string, THREE.Material>();
  private flowMaterials = new Set<THREE.ShaderMaterial>();
  private labels = new Set<SpriteText>();
  private disposed = false;

  private texture(key: string, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
    const cached = this.textures.get(key);
    if (cached) return cached as THREE.CanvasTexture;
    const { canvas, ctx } = canvas2d();
    draw(ctx);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    this.textures.set(key, t);
    return t;
  }

  material<T extends THREE.Material>(key: string, make: () => T): T {
    let m = this.materials.get(key);
    if (!m) {
      m = make();
      this.materials.set(key, m);
    }
    return m as T;
  }

  /** Solid disc with a hairline darker edge, for model nodes. */
  disc(color: string): THREE.SpriteMaterial {
    return this.material(`disc:${color}`, () =>
      spriteMaterial(
        this.texture(`disc:${color}`, (ctx) => {
          ctx.beginPath();
          ctx.arc(TEX / 2, TEX / 2, TEX / 2 - 6, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.lineWidth = 6;
          ctx.strokeStyle = "rgba(0,0,0,0.35)";
          ctx.stroke();
        }),
        1,
        true,
      ),
    );
  }

  /** Thin circular outline. */
  ring(color: string, width: number, opacity = 1): THREE.SpriteMaterial {
    return this.material(`ring:${color}:${width}:${opacity}`, () =>
      spriteMaterial(
        this.texture(`ring:${color}:${width}`, (ctx) => {
          ctx.beginPath();
          ctx.arc(TEX / 2, TEX / 2, TEX / 2 - width / 2 - 2, 0, Math.PI * 2);
          ctx.lineWidth = width;
          ctx.strokeStyle = color;
          ctx.stroke();
        }),
        opacity,
      ),
    );
  }

  /** Provider logo on a white disc; initials on a dark disc when there is no logo. */
  logo(provider: string, url: string | null | undefined): THREE.Texture {
    const key = `logo:${provider}|${url ?? ""}`;
    const cached = this.textures.get(key);
    if (cached) return cached;
    const { canvas, ctx } = canvas2d();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.textures.set(key, texture);

    const disc = () => {
      ctx.beginPath();
      ctx.arc(TEX / 2, TEX / 2, TEX / 2 - 4, 0, Math.PI * 2);
      ctx.closePath();
    };
    disc();
    ctx.fillStyle = "#1b2029";
    ctx.fill();
    ctx.fillStyle = "#c9d1db";
    ctx.font = `600 ${TEX * 0.32}px "Inter Variable", Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(provider.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?", TEX / 2, TEX / 2 + TEX * 0.02);
    texture.needsUpdate = true;

    if (url) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => {
        if (this.disposed) return;
        ctx.clearRect(0, 0, TEX, TEX);
        ctx.save();
        disc();
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.clip();
        // Keep the logo's proportions, with a little breathing room inside the disc.
        const box = TEX * 0.86;
        const scale = Math.min(box / img.width, box / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (TEX - w) / 2, (TEX - h) / 2, w, h);
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

  flowMaterial(color: string, speed: number): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.time,
        uSpeed: { value: speed },
        uRepeat: { value: 4 },
        uOpacity: { value: FLOW_OPACITY },
        uColor: { value: new THREE.Color(color) },
      },
      vertexShader: FLOW_VERTEX,
      fragmentShader: FLOW_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.flowMaterials.add(m);
    return m;
  }

  releaseFlowMaterial(m: THREE.ShaderMaterial) {
    this.flowMaterials.delete(m);
    m.dispose();
  }

  dispose() {
    this.disposed = true;
    this.tube.dispose();
    this.textures.forEach((t) => t.dispose());
    this.materials.forEach((m) => m.dispose());
    this.flowMaterials.forEach((m) => m.dispose());
    this.labels.forEach((l) => {
      l.material.map?.dispose();
      l.material.dispose();
      l.geometry.dispose();
    });
    this.textures.clear();
    this.materials.clear();
    this.flowMaterials.clear();
    this.labels.clear();
  }
}

export const FLOW_OPACITY = 0.5;
export const FLOW_OPACITY_LIT = 0.9;

const color = (s: ModelStatus) => STATUS[s].color;

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

/** A violet ring that slowly breathes around security incidents. */
function alertRing(pool: ResourcePool) {
  const s = new THREE.Sprite(pool.ring(STATUS.security_incident.color, 10, 0.8));
  s.scale.setScalar(2.8);
  return s;
}

export function createEngine(pool: ResourcePool, node: GNode): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const disc = new THREE.Sprite(pool.disc("#1b232e"));
  disc.scale.setScalar(2);
  const edge = new THREE.Sprite(pool.ring("#5a6a7e", 8));
  edge.scale.setScalar(2);
  const dot = new THREE.Sprite(pool.disc("#a9c4d4"));
  dot.scale.setScalar(0.42);
  const inner = new THREE.Sprite(pool.ring("#a9c4d4", 5, 0.6));
  inner.scale.setScalar(1.1);
  const outer = new THREE.Sprite(pool.ring("#a9c4d4", 3, 0.22));
  outer.scale.setScalar(2.7);
  const label = pool.label("LIVE ANALYSIS CORE", 0.14, "#a3adba");
  label.position.y = -1.75;
  dot.renderOrder = inner.renderOrder = edge.renderOrder = 1;

  body.add(disc, edge, outer, inner, dot, label);

  const anim = baseAnim("engine", node, body);
  anim.animate = (t, motion) => {
    if (!motion) return;
    // A slow, quiet pulse: the inner ring and the outer halo ring breathe out of phase.
    inner.scale.setScalar(1.1 + 0.06 * Math.sin(t * 1.2));
    outer.scale.setScalar(2.7 + 0.12 * Math.sin(t * 0.8 + 1));
  };
  group.userData.anim = anim;
  return group;
}

export function createProvider(pool: ResourcePool, node: GNode): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const logoMaterial = spriteMaterial(pool.logo(node.name, node.avatar), 1, true);
  const logo = new THREE.Sprite(logoMaterial);
  logo.scale.setScalar(2);
  const ring = new THREE.Sprite(pool.ring(color(node.status), 10));
  ring.scale.setScalar(2.3);
  ring.renderOrder = 1;
  const label = pool.label(node.name, 0.3);
  label.position.y = -1.55;
  body.add(logo, ring, label);

  const anim = baseAnim("provider", node, body);
  anim.ring = ring;
  if (node.status === "security_incident") {
    anim.alert = alertRing(pool);
    body.add(anim.alert);
  }
  // The logo material isn't pooled (one per provider): dispose it with the node.
  group.userData.dispose = () => logoMaterial.dispose();
  group.userData.anim = anim;
  return group;
}

export function createModel(pool: ResourcePool, node: GNode): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const disc = new THREE.Sprite(pool.disc(color(node.status)));
  disc.scale.setScalar(2);
  body.add(disc);
  const anim = baseAnim("model", node, body);
  anim.disc = disc;
  if (node.status === "security_incident") {
    anim.alert = alertRing(pool);
    body.add(anim.alert);
  }
  group.userData.anim = anim;
  return group;
}

/** Applies a status change to an existing node. */
export function setStatus(pool: ResourcePool, anim: NodeAnim, status: ModelStatus) {
  if (anim.status === status) return;
  anim.status = status;
  if (anim.disc) anim.disc.material = pool.disc(color(status));
  if (anim.ring) anim.ring.material = pool.ring(color(status), 10);
  if (status === "security_incident" && !anim.alert) {
    anim.alert = alertRing(pool);
    anim.body.add(anim.alert);
  } else if (status !== "security_incident" && anim.alert) {
    anim.body.remove(anim.alert);
    anim.alert = undefined;
  }
}

/** One frame of node animation: eased size, idle float, hover and update pulses. */
export function animateNode(anim: NodeAnim, t: number, dt: number, motion: boolean) {
  const hover = anim.hovered ? 1.15 : 1;
  anim.pulse = Math.max(0, anim.pulse - dt);
  const pulse = anim.pulse > 0 ? 1 + 0.2 * Math.sin((anim.pulse / 1.2) * Math.PI) : 1;
  const goal = anim.target * hover * pulse;
  anim.scale = motion ? anim.scale + (goal - anim.scale) * Math.min(1, dt * 5) : goal;
  anim.body.scale.setScalar(Math.max(0.0001, anim.scale * anim.radius));

  if (motion && anim.kind !== "engine") {
    const amp = anim.kind === "provider" ? 1 : 0.5;
    anim.body.position.y = Math.sin(t * 0.5 + anim.phase) * amp;
    anim.body.position.x = Math.cos(t * 0.4 + anim.phase) * amp * 0.5;
  } else {
    anim.body.position.set(0, 0, 0);
  }

  if (anim.alert) anim.alert.scale.setScalar(motion ? 2.6 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.5)) : 2.8);
  anim.animate?.(t, motion);
}

export function disposeNode(group: THREE.Object3D) {
  (group.userData.dispose as (() => void) | undefined)?.();
}

/** A thick tube carrying a continuous flow from a provider into the core. */
export function createFlowLink(pool: ResourcePool, colorHex: string, width: number, speed: number): THREE.Mesh {
  const mesh = new THREE.Mesh(pool.tube, pool.flowMaterial(colorHex, speed));
  mesh.userData.width = width;
  mesh.userData.dispose = () => pool.releaseFlowMaterial(mesh.material as THREE.ShaderMaterial);
  return mesh;
}

/** Stretches a flow tube between two points, stopping at the nodes' edges. */
export function placeFlowLink(
  mesh: THREE.Mesh,
  start: THREE.Vector3Like,
  end: THREE.Vector3Like,
  startGap: number,
  endGap: number,
) {
  const s = new THREE.Vector3(start.x, start.y, start.z);
  const e = new THREE.Vector3(end.x, end.y, end.z);
  const dir = e.clone().sub(s);
  const full = dir.length();
  if (full < 1e-3) return;
  dir.divideScalar(full);
  const length = Math.max(0.1, full - startGap - endGap);
  s.addScaledVector(dir, startGap);
  mesh.position.copy(s).addScaledVector(dir, length / 2);
  mesh.quaternion.setFromUnitVectors(UP, dir);
  const width = mesh.userData.width as number;
  mesh.scale.set(width, length, width);
  // Keep the bands evenly spaced whatever the link length.
  (mesh.material as THREE.ShaderMaterial).uniforms.uRepeat.value = length / 70;
}
