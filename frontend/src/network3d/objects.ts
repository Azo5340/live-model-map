import * as THREE from "three";
import SpriteText from "three-spritetext";
import { STATUS } from "../format";
import type { ModelStatus } from "../types";
import type { GNode } from "./graphData";

/**
 * Three.js objects for the 3D network.
 *
 * Nodes are flat camera-facing badges (no shading or reflections) that behave
 * like drops of fluid: they breathe gently and wobble each time they send a
 * light pulse. Every node is linked to a bright core by a stream on which comet
 * pulses travel; the core gains energy and ripples as pulses arrive.
 *
 * Each node is a Group whose `body` child holds the visuals: the force
 * simulation moves the Group, the animation loop scales, wobbles and floats the
 * body. Textures and materials are shared through a ResourcePool and disposed
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
  /** Fluid wobble: strength (decays) and time since the last kick. */
  wobble: number;
  wobbleAge: number;
  /** How far the node is drawn toward the core (0..1) while its light train travels, and which way. */
  pull: number;
  pullDir: THREE.Vector3;
  disc?: THREE.Sprite;
  ring?: THREE.Sprite;
  glow?: THREE.Sprite;
  alert?: THREE.Sprite;
  animate?: (t: number, dt: number, motion: boolean) => void;
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

function glowMaterial(map: THREE.Texture, color: string, opacity: number) {
  return new THREE.SpriteMaterial({
    map,
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

const FLOW_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// A dim stream with a *train* of light travelling from source (v = 0) to target
// (v = 1): a bright headlight followed by a few cars, measured in scene units so
// they look the same on short and long links. The head position uses the same
// formula as pulseHead() so nodes move in step with their train.
const FLOW_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uRate;
  uniform float uPhase;
  uniform float uOpacity;
  uniform float uLength;
  uniform vec3 uColor;
  varying vec2 vUv;
  const float TRAIN = 70.0;   // train length, scene units
  const float CAR = 14.0;     // car + gap length
  void main() {
    float head = fract(uTime * uRate + uPhase);
    float behind = (head - vUv.y) * uLength;            // distance behind the headlight
    float inTrain = step(0.0, behind) * step(behind, TRAIN);
    float c = fract(behind / CAR);
    float car = smoothstep(0.0, 0.12, c) * smoothstep(0.78, 0.6, c);
    float fade = 1.0 - 0.65 * clamp(behind / TRAIN, 0.0, 1.0);
    float train = inTrain * car * fade;
    float headlight = exp(-abs(behind) * 0.35);
    float ends = smoothstep(0.0, 0.03, vUv.y) * smoothstep(0.0, 0.03, 1.0 - vUv.y);
    float light = 0.09 + 1.05 * train + 1.5 * headlight;
    vec3 color = mix(uColor, vec3(1.0), clamp(0.7 * headlight + 0.25 * train, 0.0, 1.0));
    gl_FragColor = vec4(color * light, uOpacity * ends);
  }
`;

/** Where the pulse of a stream is (0 at the source, 1 at the core), same as the shader. */
export function pulseHead(t: number, rate: number, phase: number): number {
  const x = t * rate + phase;
  return x - Math.floor(x);
}

export class ResourcePool {
  /** Open tube along +Y, unit height and radius; scaled per link. */
  readonly tube = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
  /** Shared by every stream material so one update per frame animates all of them. */
  readonly time = { value: 0 };
  readonly glow: THREE.CanvasTexture;
  private textures = new Map<string, THREE.Texture>();
  private materials = new Map<string, THREE.Material>();
  private owned = new Set<THREE.Material>();
  private labels = new Set<SpriteText>();
  private disposed = false;

  constructor() {
    const { canvas, ctx } = canvas2d();
    const g = ctx.createRadialGradient(TEX / 2, TEX / 2, 0, TEX / 2, TEX / 2, TEX / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.2, "rgba(255,255,255,0.55)");
    g.addColorStop(0.5, "rgba(255,255,255,0.12)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, TEX, TEX);
    this.glow = new THREE.CanvasTexture(canvas);
    this.glow.colorSpace = THREE.SRGBColorSpace;
  }

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

  /** A per-node material (its opacity animates); freed with the pool. */
  own<T extends THREE.Material>(m: T): T {
    this.owned.add(m);
    return m;
  }

  release(m: THREE.Material) {
    this.owned.delete(m);
    m.dispose();
  }

  /** A luminous orb: white-hot center fading through the color to transparent (additive). */
  orb(color: string): THREE.SpriteMaterial {
    return this.material(`orb:${color}`, () =>
      glowMaterial(
        this.texture(`orb:${color}`, (ctx) => {
          const c = new THREE.Color(color);
          const rgb = (a: number) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
          const g = ctx.createRadialGradient(TEX / 2, TEX / 2, 0, TEX / 2, TEX / 2, TEX / 2);
          g.addColorStop(0, "rgba(255,255,255,1)");
          g.addColorStop(0.18, "rgba(255,255,255,0.95)");
          g.addColorStop(0.32, rgb(0.95));
          g.addColorStop(0.55, rgb(0.45));
          g.addColorStop(1, rgb(0));
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, TEX, TEX);
        }),
        "#ffffff",
        1,
      ),
    );
  }

  /** Thin light rays radiating from the center, for the core's starburst. */
  starburst(): THREE.CanvasTexture {
    return this.texture("starburst", (ctx) => {
      ctx.translate(TEX / 2, TEX / 2);
      for (let i = 0; i < 28; i++) {
        const long = i % 2 === 0;
        const len = (TEX / 2) * (long ? 0.98 : 0.62);
        const g = ctx.createLinearGradient(0, 0, len, 0);
        g.addColorStop(0, "rgba(255,255,255,0.9)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.strokeStyle = g;
        ctx.lineWidth = long ? 2.2 : 1.4;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(len, 0);
        ctx.stroke();
        ctx.rotate((Math.PI * 2) / 28);
      }
    });
  }

  /** Solid disc with a hairline darker edge. */
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

  /** Thin circular outline texture. */
  ringTexture(color: string, width: number): THREE.CanvasTexture {
    return this.texture(`ring:${color}:${width}`, (ctx) => {
      ctx.beginPath();
      ctx.arc(TEX / 2, TEX / 2, TEX / 2 - width / 2 - 2, 0, Math.PI * 2);
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.stroke();
    });
  }

  /** A glowing status ring (additive) around provider logos. */
  glowRing(color: string): THREE.SpriteMaterial {
    return this.material(`glowring:${color}`, () => glowMaterial(this.ringTexture("#ffffff", 12), color, 0.95));
  }

  ring(color: string, width: number, opacity = 1): THREE.SpriteMaterial {
    return this.material(`ring:${color}:${width}:${opacity}`, () => spriteMaterial(this.ringTexture(color, width), opacity));
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

  streamMaterial(color: string, rate: number, phase: number): THREE.ShaderMaterial {
    return this.own(
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: this.time,
          uRate: { value: rate },
          uPhase: { value: phase },
          uOpacity: { value: STREAM_OPACITY },
          uLength: { value: 100 },
          uColor: { value: new THREE.Color(color) },
        },
        vertexShader: FLOW_VERTEX,
        fragmentShader: FLOW_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
  }

  dispose() {
    this.disposed = true;
    this.tube.dispose();
    this.glow.dispose();
    this.textures.forEach((t) => t.dispose());
    this.materials.forEach((m) => m.dispose());
    this.owned.forEach((m) => m.dispose());
    this.labels.forEach((l) => {
      l.material.map?.dispose();
      l.material.dispose();
      l.geometry.dispose();
    });
    this.textures.clear();
    this.materials.clear();
    this.owned.clear();
    this.labels.clear();
  }
}

export const STREAM_OPACITY = 0.5;
const BASE_GLOW = { provider: 0.2, model: 0.16 };
export const STREAM_OPACITY_LIT = 1;

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
    wobble: 0,
    wobbleAge: 0,
    pull: 0,
    pullDir: new THREE.Vector3(),
  };
}

/** A violet ring that slowly breathes around security incidents. */
function alertRing(pool: ResourcePool) {
  const s = new THREE.Sprite(pool.ring(STATUS.security_incident.color, 10, 0.8));
  s.scale.setScalar(2.8);
  return s;
}

/** Makes a node wobble like a drop of fluid (and flash, if it has a glow). */
export function kick(anim: NodeAnim, strength: number) {
  anim.wobble = Math.min(1, Math.max(anim.wobble * Math.exp(-3 * anim.wobbleAge), 0) + strength);
  anim.wobbleAge = 0;
}

export function createEngine(pool: ResourcePool, node: GNode): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const halo = new THREE.Sprite(pool.own(glowMaterial(pool.glow, "#4f8dff", 0.6)));
  halo.scale.setScalar(9);
  const nebula = new THREE.Sprite(pool.own(glowMaterial(pool.glow, "#8f6bff", 0.18)));
  nebula.scale.setScalar(14);
  const aura = new THREE.Sprite(pool.own(glowMaterial(pool.glow, "#bfe3ff", 0.9)));
  aura.scale.setScalar(3.6);
  const rays = new THREE.Sprite(pool.own(glowMaterial(pool.starburst(), "#d6ecff", 0.55)));
  rays.scale.setScalar(8);
  const rays2 = new THREE.Sprite(pool.own(glowMaterial(pool.starburst(), "#a9b8ff", 0.3)));
  rays2.scale.setScalar(5.5);
  const heart = new THREE.Sprite(pool.own(glowMaterial(pool.glow, "#ffffff", 1)));
  heart.scale.setScalar(2);
  const edge = new THREE.Sprite(pool.own(glowMaterial(pool.ringTexture("#ffffff", 5), "#9fd2ff", 0.5)));
  edge.scale.setScalar(2.4);
  const inner = new THREE.Sprite(pool.own(glowMaterial(pool.ringTexture("#ffffff", 4), "#d9efff", 0.6)));
  inner.scale.setScalar(1.3);
  const label = pool.label("LIVE ANALYSIS CORE", 0.12, "#c9d8f2");
  label.position.y = -2.4;

  // Ripples spread out from the core when pulses arrive.
  const ripples = Array.from({ length: 5 }, () => {
    const r = new THREE.Sprite(pool.own(glowMaterial(pool.ringTexture("#ffffff", 6), "#9fd2f2", 0)));
    r.visible = false;
    r.userData.age = 1;
    return r;
  });

  body.add(nebula, halo, rays, rays2, aura, edge, inner, heart, label, ...ripples);

  const anim = baseAnim("engine", node, body);
  let energy = 0.3;
  let sinceRipple = 0;
  let next = 0;
  group.userData.receive = (amount: number) => {
    energy = Math.min(1, energy + amount);
    if (sinceRipple > 0.35) {
      sinceRipple = 0;
      const r = ripples[next++ % ripples.length];
      r.userData.age = 0;
      r.visible = true;
    }
  };
  anim.animate = (t, dt, motion) => {
    energy = Math.max(0.25, energy * Math.exp(-0.9 * dt));
    sinceRipple += dt;
    const breathe = motion ? Math.sin(t * 1.4) : 0;
    (halo.material as THREE.SpriteMaterial).opacity = 0.3 + 0.25 * energy + 0.04 * breathe;
    (aura.material as THREE.SpriteMaterial).opacity = 0.4 + 0.3 * energy;
    (rays.material as THREE.SpriteMaterial).opacity = 0.25 + 0.3 * energy;
    heart.scale.setScalar(1.4 + 0.45 * energy + 0.06 * breathe);
    halo.scale.setScalar(7 + 1.5 * energy + 0.3 * breathe);
    rays.scale.setScalar(6.5 + 2 * energy);
    if (motion) {
      (rays.material as THREE.SpriteMaterial).rotation = t * 0.05;
      (rays2.material as THREE.SpriteMaterial).rotation = -t * 0.08;
    }
    inner.scale.setScalar(1.3 + 0.1 * breathe);
    for (const r of ripples) {
      if (!r.visible) continue;
      r.userData.age += dt / 1.6;
      const age = r.userData.age as number;
      if (age >= 1 || !motion) {
        r.visible = false;
        continue;
      }
      r.scale.setScalar(2.4 + 6 * age);
      (r.material as THREE.SpriteMaterial).opacity = 0.6 * (1 - age) * (1 - age);
    }
  };
  group.userData.anim = anim;
  return group;
}

export function createProvider(pool: ResourcePool, node: GNode): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const glowMat = pool.own(glowMaterial(pool.glow, color(node.status), BASE_GLOW.provider));
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(3.6);
  const logoMaterial = pool.own(spriteMaterial(pool.logo(node.name, node.avatar), 1, true));
  logoMaterial.color.set("#9aa7c9"); // dimmed below the bloom threshold so logos stay readable
  const logo = new THREE.Sprite(logoMaterial);
  logo.scale.setScalar(2);
  const ring = new THREE.Sprite(pool.glowRing(color(node.status)));
  ring.scale.setScalar(2.35);
  const label = pool.label(node.name, 0.3, "#c3cee6");
  label.position.y = -1.7;
  body.add(glow, logo, ring, label);

  const anim = baseAnim("provider", node, body);
  anim.ring = ring;
  anim.glow = glow;
  if (node.status === "security_incident") {
    anim.alert = alertRing(pool);
    body.add(anim.alert);
  }
  group.userData.dispose = () => {
    pool.release(logoMaterial);
    pool.release(glowMat);
  };
  group.userData.anim = anim;
  return group;
}

export function createModel(pool: ResourcePool, node: GNode): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const glowMat = pool.own(glowMaterial(pool.glow, color(node.status), BASE_GLOW.model));
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(3.6);
  const disc = new THREE.Sprite(pool.orb(color(node.status)));
  disc.scale.setScalar(2.4);
  body.add(glow, disc);
  const anim = baseAnim("model", node, body);
  anim.disc = disc;
  anim.glow = glow;
  if (node.status === "security_incident") {
    anim.alert = alertRing(pool);
    body.add(anim.alert);
  }
  group.userData.dispose = () => pool.release(glowMat);
  group.userData.anim = anim;
  return group;
}

/** Applies a status change to an existing node. */
export function setStatus(pool: ResourcePool, anim: NodeAnim, status: ModelStatus) {
  if (anim.status === status) return;
  anim.status = status;
  if (anim.disc) anim.disc.material = pool.orb(color(status));
  if (anim.ring) anim.ring.material = pool.glowRing(color(status));
  if (anim.glow) (anim.glow.material as THREE.SpriteMaterial).color.set(color(status));
  if (status === "security_incident" && !anim.alert) {
    anim.alert = alertRing(pool);
    anim.body.add(anim.alert);
  } else if (status !== "security_incident" && anim.alert) {
    anim.body.remove(anim.alert);
    anim.alert = undefined;
  }
}

/**
 * One frame of node animation: eased size, idle float, a slow fluid "breathing"
 * and the damped squash-and-stretch wobble triggered by each light pulse.
 */
export function animateNode(anim: NodeAnim, t: number, dt: number, motion: boolean) {
  const hover = anim.hovered ? 1.15 : 1;
  anim.pulse = Math.max(0, anim.pulse - dt);
  const pulse = anim.pulse > 0 ? 1 + 0.2 * Math.sin((anim.pulse / 1.2) * Math.PI) : 1;
  const goal = anim.target * hover * pulse;
  anim.scale = motion ? anim.scale + (goal - anim.scale) * Math.min(1, dt * 5) : goal;
  const size = Math.max(0.0001, anim.scale * anim.radius);

  let sx = 1;
  let sy = 1;
  let flash = 0;
  if (motion && anim.kind !== "engine") {
    anim.wobbleAge += dt;
    const w = anim.wobble * Math.exp(-3 * anim.wobbleAge);
    const jelly = 0.22 * w * Math.sin(16 * anim.wobbleAge);
    const breathe = 0.035 * Math.sin(t * 1.6 + anim.phase);
    const breathe2 = 0.035 * Math.sin(t * 1.6 + anim.phase + Math.PI / 2);
    sx = 1 + jelly + breathe;
    sy = 1 - jelly + breathe2;
    flash = w;
    const amp = anim.kind === "provider" ? 1.5 : 0.8;
    anim.body.position.set(Math.cos(t * 0.4 + anim.phase) * amp * 0.5, Math.sin(t * 0.5 + anim.phase) * amp, 0);
    // Drawn toward the core while its train travels, then springing back.
    anim.body.position.addScaledVector(anim.pullDir, anim.pull * anim.radius * 0.9);
    // Stretched along the pull, like a drop being tugged.
    sy += 0.12 * anim.pull;
    sx -= 0.06 * anim.pull;
  } else {
    anim.body.position.set(0, 0, 0);
  }
  anim.body.scale.set(size * sx, size * sy, size);

  if (anim.glow) {
    (anim.glow.material as THREE.SpriteMaterial).opacity =
      (anim.kind === "provider" ? BASE_GLOW.provider : BASE_GLOW.model) + 0.6 * flash;
  }
  if (anim.alert) anim.alert.scale.setScalar(motion ? 2.6 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.5)) : 2.8);
  anim.animate?.(t, dt, motion);
}

export function disposeNode(group: THREE.Object3D) {
  (group.userData.dispose as (() => void) | undefined)?.();
}

/** A tube carrying light pulses from a node into the core. */
export function createStream(
  pool: ResourcePool,
  colorHex: string,
  width: number,
  rate: number,
  phase: number,
): THREE.Mesh {
  const material = pool.streamMaterial(colorHex, rate, phase);
  const mesh = new THREE.Mesh(pool.tube, material);
  mesh.userData.width = width;
  mesh.userData.rate = rate;
  mesh.userData.phase = phase;
  mesh.userData.dispose = () => pool.release(material);
  return mesh;
}

/** Stretches a stream between two points, stopping at the nodes' edges. */
export function placeStream(
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
  (mesh.material as THREE.ShaderMaterial).uniforms.uLength.value = length;
}
