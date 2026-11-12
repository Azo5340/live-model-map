import * as THREE from "three";
import SpriteText from "three-spritetext";
import { STATUS, THEME } from "../format";
import type { ModelStatus } from "../types";
import type { GNode, Tier } from "./graphData";

/**
 * Three.js objects for the 3D network.
 *
 * Nodes are camera-facing badges on a deep-navy background: providers show their
 * logo in a status ring, models are soft orbs. Size, glow and label follow a
 * three-tier hierarchy (main / secondary / minor). Each node fades smoothly when
 * the view focuses on something else. Every node is linked to a softly lit core
 * by a stream on which short trains of light roll in.
 *
 * Each node is a Group whose `body` child holds the visuals: the force
 * simulation moves the Group, the animation loop scales, wobbles, floats and
 * fades the body. Textures are shared through a ResourcePool; per-node materials
 * (needed for fading) are owned by the pool and freed with it.
 */

export interface NodeAnim {
  body: THREE.Group;
  kind: GNode["kind"];
  tier: Tier;
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
  /** Focus fading: current visibility and where it is heading (1 = full, lower = dimmed). */
  fade: number;
  fadeTarget: number;
  /** Materials whose opacity follows `fade`, with their resting opacity. */
  fadeables: { m: THREE.SpriteMaterial; base: number }[];
  disc?: THREE.Sprite;
  ring?: THREE.Sprite;
  glow?: THREE.Sprite;
  glowBase: number;
  label?: THREE.Sprite;
  /** Minor providers only show their name when in focus. */
  labelAlways: boolean;
  alert?: THREE.Sprite;
  animate?: (t: number, dt: number, motion: boolean) => void;
}

const TEX = 256; // canvas size for badge textures
const UP = new THREE.Vector3(0, 1, 0);

/** Decorative objects (glows, rings, labels, streams) are skipped by mouse picking, which only tests node badges. */
function noPick<T extends THREE.Object3D>(...objects: T[]): void {
  for (const o of objects) o.raycast = () => {};
}

function canvas2d() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TEX;
  return { canvas, ctx: canvas.getContext("2d")! };
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

// A faint stream with a *train* of light travelling from source (v = 0) to target
// (v = 1): a headlight followed by a few cars, measured in scene units so they
// look the same on short and long links. The head position uses the same formula
// as pulseHead() so nodes move in step with their train.
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
    float light = 0.35 + 0.9 * train + 1.1 * headlight;
    vec3 color = mix(uColor, vec3(0.86, 0.91, 1.0), clamp(0.45 * headlight + 0.15 * train, 0.0, 1.0));
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
  readonly tube = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  /** Shared by every stream material so one update per frame animates all of them. */
  readonly time = { value: 0 };
  readonly glow: THREE.CanvasTexture;
  private textures = new Map<string, THREE.Texture>();
  private owned = new Set<THREE.Material>();
  private labels = new Set<SpriteText>();
  private disposed = false;

  constructor() {
    // A soft, wide falloff: diffuse halos rather than hard white blobs.
    const { canvas, ctx } = canvas2d();
    const g = ctx.createRadialGradient(TEX / 2, TEX / 2, 0, TEX / 2, TEX / 2, TEX / 2);
    g.addColorStop(0, "rgba(255,255,255,0.85)");
    g.addColorStop(0.25, "rgba(255,255,255,0.4)");
    g.addColorStop(0.6, "rgba(255,255,255,0.08)");
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

  /** A per-node material (its opacity animates); freed with the pool. */
  own<T extends THREE.Material>(m: T): T {
    this.owned.add(m);
    return m;
  }

  release(m: THREE.Material) {
    this.owned.delete(m);
    m.dispose();
  }

  /** A soft orb: a light center easing into the color, then a clean edge (white texture, tinted per node). */
  orbTexture(): THREE.CanvasTexture {
    return this.texture("orb", (ctx) => {
      const g = ctx.createRadialGradient(TEX / 2, TEX / 2, 0, TEX / 2, TEX / 2, TEX / 2 - 4);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.3, "rgba(255,255,255,0.92)");
      g.addColorStop(0.8, "rgba(255,255,255,0.7)");
      g.addColorStop(0.97, "rgba(255,255,255,0.55)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(TEX / 2, TEX / 2, TEX / 2 - 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /** Circular outline with the same relative stroke for every node. */
  ringTexture(width: number): THREE.CanvasTexture {
    return this.texture(`ring:${width}`, (ctx) => {
      ctx.beginPath();
      ctx.arc(TEX / 2, TEX / 2, TEX / 2 - width / 2 - 2, 0, Math.PI * 2);
      ctx.lineWidth = width;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    });
  }

  /** Thin light rays radiating from the center, for the core. */
  starburst(): THREE.CanvasTexture {
    return this.texture("starburst", (ctx) => {
      ctx.translate(TEX / 2, TEX / 2);
      for (let i = 0; i < 24; i++) {
        const long = i % 2 === 0;
        const len = (TEX / 2) * (long ? 0.95 : 0.6);
        const g = ctx.createLinearGradient(0, 0, len, 0);
        g.addColorStop(0, "rgba(255,255,255,0.7)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.strokeStyle = g;
        ctx.lineWidth = long ? 1.8 : 1.2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(len, 0);
        ctx.stroke();
        ctx.rotate((Math.PI * 2) / 24);
      }
    });
  }

  /** Provider logo filling a disc like a round avatar; initials on navy when there is no logo. */
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
    ctx.fillStyle = "#14203d";
    ctx.fill();
    ctx.fillStyle = THEME.text;
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
        // Hugging Face avatars are made for circular crops: fill the disc ("cover"),
        // centered and undistorted, like a profile picture.
        const scale = Math.max(TEX / img.width, TEX / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (TEX - w) / 2, (TEX - h) / 2, w, h);
        ctx.restore();
        disc();
        ctx.lineWidth = 5;
        ctx.strokeStyle = "rgba(8,13,28,0.6)";
        ctx.stroke();
        texture.needsUpdate = true;
      };
      img.src = url;
    }
    return texture;
  }

  label(text: string, height: number, color: string = THEME.text): SpriteText {
    const s = new SpriteText(text, height, color);
    s.fontFace = '"Inter Variable", Inter, system-ui, sans-serif';
    s.fontWeight = "500";
    s.backgroundColor = false;
    s.padding = 0;
    s.material.depthWrite = false;
    this.labels.add(s);
    return s;
  }

  streamMaterial(color: string, rate: number, phase: number, opacity: number): THREE.ShaderMaterial {
    return this.own(
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: this.time,
          uRate: { value: rate },
          uPhase: { value: phase },
          uOpacity: { value: opacity },
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
    this.owned.forEach((m) => m.dispose());
    this.labels.forEach((l) => {
      l.material.map?.dispose();
      l.material.dispose();
      l.geometry.dispose();
    });
    this.textures.clear();
    this.owned.clear();
    this.labels.clear();
  }
}

/** Opacity of a dimmed (out-of-focus) node. */
export const DIMMED = 0.16;

const color = (s: ModelStatus) => STATUS[s].color;

// Glow strength by tier: more important nodes glow more, minor ones barely.
const GLOW = {
  provider: { opacity: [0.24, 0.15, 0.08], scale: [2.7, 2.45, 2.2] },
  model: { opacity: [0.22, 0.12, 0.06], scale: [2.8, 2.5, 2.2] },
};

function baseAnim(kind: GNode["kind"], node: GNode, body: THREE.Group): NodeAnim {
  return {
    body,
    kind,
    tier: node.tier,
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
    fade: 1,
    fadeTarget: 1,
    fadeables: [],
    glowBase: 0,
    labelAlways: true,
  };
}

function fadeable(anim: NodeAnim, m: THREE.SpriteMaterial) {
  anim.fadeables.push({ m, base: m.opacity });
}

/** A ring that slowly breathes around security incidents. */
function alertRing(pool: ResourcePool, anim: NodeAnim) {
  const m = pool.own(glowMaterial(pool.ringTexture(10), STATUS.security_incident.color, 0.75));
  const s = new THREE.Sprite(m);
  s.scale.setScalar(2.7);
  noPick(s);
  fadeable(anim, m);
  return s;
}

/** Makes a node wobble like a drop of fluid (and brighten briefly). */
export function kick(anim: NodeAnim, strength: number) {
  anim.wobble = Math.min(1, Math.max(anim.wobble * Math.exp(-3 * anim.wobbleAge), 0) + strength);
  anim.wobbleAge = 0;
}

export function createEngine(pool: ResourcePool, node: GNode): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  // A diffuse electric-blue core: no pure white, a gradual falloff into the
  // network, so it stays the focal point without washing out the center.
  const halo = new THREE.Sprite(pool.own(glowMaterial(pool.glow, THEME.blue, 0.4)));
  halo.scale.setScalar(4.6);
  const nebula = new THREE.Sprite(pool.own(glowMaterial(pool.glow, THEME.violet, 0.1)));
  nebula.scale.setScalar(7);
  const aura = new THREE.Sprite(pool.own(glowMaterial(pool.glow, "#6aa2ff", 0.32)));
  aura.scale.setScalar(2.5);
  const rays = new THREE.Sprite(pool.own(glowMaterial(pool.starburst(), "#8fb6ff", 0.14)));
  rays.scale.setScalar(4.4);
  const heart = new THREE.Sprite(pool.own(glowMaterial(pool.glow, "#bcd3ff", 0.7)));
  heart.scale.setScalar(1.15);
  const edge = new THREE.Sprite(pool.own(glowMaterial(pool.ringTexture(5), THEME.blue, 0.45)));
  edge.scale.setScalar(2.2);
  const inner = new THREE.Sprite(pool.own(glowMaterial(pool.ringTexture(4), "#9cc0ff", 0.3)));
  inner.scale.setScalar(1.35);
  const label = pool.label("LIVE ANALYSIS CORE", 0.13, THEME.text);
  label.material.opacity = 0.75;
  label.position.y = -1.75;

  // Ripples spread out from the core when trains arrive.
  const ripples = Array.from({ length: 4 }, () => {
    const r = new THREE.Sprite(pool.own(glowMaterial(pool.ringTexture(5), "#6aa2ff", 0)));
    r.visible = false;
    r.userData.age = 1;
    return r;
  });

  noPick(nebula, halo, rays, aura, edge, inner, label, ...ripples);
  body.add(nebula, halo, rays, aura, edge, inner, heart, label, ...ripples);

  const anim = baseAnim("engine", node, body);
  let energy = 0.3;
  let sinceRipple = 0;
  let next = 0;
  group.userData.receive = (amount: number) => {
    energy = Math.min(1, energy + amount);
    if (sinceRipple > 0.5) {
      sinceRipple = 0;
      const r = ripples[next++ % ripples.length];
      r.userData.age = 0;
      r.visible = true;
    }
  };
  anim.animate = (t, dt, motion) => {
    energy = Math.max(0.25, energy * Math.exp(-0.9 * dt));
    sinceRipple += dt;
    const breathe = motion ? Math.sin(t * 1.2) : 0;
    (halo.material as THREE.SpriteMaterial).opacity = 0.3 + 0.16 * energy + 0.03 * breathe;
    (aura.material as THREE.SpriteMaterial).opacity = 0.3 + 0.16 * energy;
    (rays.material as THREE.SpriteMaterial).opacity = 0.08 + 0.1 * energy;
    heart.scale.setScalar(1.05 + 0.2 * energy + 0.04 * breathe);
    halo.scale.setScalar(5 + 0.9 * energy + 0.15 * breathe);
    if (motion) (rays.material as THREE.SpriteMaterial).rotation = t * 0.03;
    inner.scale.setScalar(1.35 + 0.06 * breathe);
    for (const r of ripples) {
      if (!r.visible) continue;
      r.userData.age += dt / 1.8;
      const age = r.userData.age as number;
      if (age >= 1 || !motion) {
        r.visible = false;
        continue;
      }
      r.scale.setScalar(2.2 + 4.5 * age);
      (r.material as THREE.SpriteMaterial).opacity = 0.32 * (1 - age) * (1 - age);
    }
  };
  group.userData.anim = anim;
  return group;
}

export function createProvider(pool: ResourcePool, node: GNode): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const anim = baseAnim("provider", node, body);

  const glowMat = pool.own(glowMaterial(pool.glow, color(node.status), GLOW.provider.opacity[node.tier]));
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(GLOW.provider.scale[node.tier]);
  const logoMat = pool.own(
    new THREE.SpriteMaterial({ map: pool.logo(node.name, node.avatar), transparent: true, depthWrite: false }),
  );
  logoMat.color.set("#cfcfcf"); // neutral dim: true logo colors, kept under the bloom threshold
  const logo = new THREE.Sprite(logoMat);
  logo.scale.setScalar(2);
  logo.renderOrder = 2;
  const ringMat = pool.own(glowMaterial(pool.ringTexture(9), color(node.status), 0.85));
  const ring = new THREE.Sprite(ringMat);
  ring.scale.setScalar(2.22);
  ring.renderOrder = 3;
  const label = pool.label(node.name, 0.26, THEME.text);
  label.material.opacity = 0.82;
  label.position.y = -1.55;
  label.renderOrder = 3;
  // Minor providers keep their name for when they're in focus, to avoid label clutter.
  anim.labelAlways = node.tier < 2;
  label.visible = anim.labelAlways;

  noPick(glow, ring, label);
  body.add(glow, logo, ring, label);

  anim.ring = ring;
  anim.glow = glow;
  anim.glowBase = glowMat.opacity;
  anim.label = label;
  for (const m of [glowMat, logoMat, ringMat, label.material]) fadeable(anim, m);
  if (node.status === "security_incident") {
    anim.alert = alertRing(pool, anim);
    body.add(anim.alert);
  }
  group.userData.dispose = () => [glowMat, logoMat, ringMat].forEach((m) => pool.release(m));
  group.userData.anim = anim;
  return group;
}

export function createModel(pool: ResourcePool, node: GNode): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const anim = baseAnim("model", node, body);

  const glowMat = pool.own(glowMaterial(pool.glow, color(node.status), GLOW.model.opacity[node.tier]));
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(GLOW.model.scale[node.tier]);
  const orbMat = pool.own(
    new THREE.SpriteMaterial({ map: pool.orbTexture(), color: new THREE.Color(color(node.status)), transparent: true, depthWrite: false }),
  );
  const disc = new THREE.Sprite(orbMat);
  disc.scale.setScalar(2);
  disc.renderOrder = 1;
  noPick(glow);
  body.add(glow, disc);

  anim.disc = disc;
  anim.glow = glow;
  anim.glowBase = glowMat.opacity;
  for (const m of [glowMat, orbMat]) fadeable(anim, m);
  if (node.status === "security_incident") {
    anim.alert = alertRing(pool, anim);
    body.add(anim.alert);
  }
  group.userData.dispose = () => [glowMat, orbMat].forEach((m) => pool.release(m));
  group.userData.anim = anim;
  return group;
}

/** Applies a status change to an existing node (colors only; the hierarchy is unchanged). */
export function setStatus(pool: ResourcePool, anim: NodeAnim, status: ModelStatus) {
  if (anim.status === status) return;
  anim.status = status;
  const c = color(status);
  if (anim.disc) (anim.disc.material as THREE.SpriteMaterial).color.set(c);
  if (anim.ring) (anim.ring.material as THREE.SpriteMaterial).color.set(c);
  if (anim.glow) (anim.glow.material as THREE.SpriteMaterial).color.set(c);
  if (status === "security_incident" && !anim.alert) {
    anim.alert = alertRing(pool, anim);
    anim.body.add(anim.alert);
  } else if (status !== "security_incident" && anim.alert) {
    anim.body.remove(anim.alert);
    anim.fadeables = anim.fadeables.filter((f) => f.m !== anim.alert!.material);
    pool.release(anim.alert.material);
    anim.alert = undefined;
  }
}

/** Focus state of a node: in focus, dimmed, or neutral (no focus anywhere). */
export function setFocus(anim: NodeAnim, visible: boolean, labelled: boolean) {
  anim.fadeTarget = visible ? 1 : DIMMED;
  if (anim.label && !anim.labelAlways) anim.label.visible = labelled;
}

/**
 * One frame of node animation: eased size, idle float, a slow fluid breathing,
 * the damped wobble triggered by each light train, hover emphasis and focus fading.
 */
export function animateNode(anim: NodeAnim, t: number, dt: number, motion: boolean) {
  const hover = anim.hovered ? 1.12 : 1;
  anim.pulse = Math.max(0, anim.pulse - dt);
  const pulse = anim.pulse > 0 ? 1 + 0.15 * Math.sin((anim.pulse / 1.2) * Math.PI) : 1;
  const goal = anim.target * hover * pulse;
  anim.scale = motion ? anim.scale + (goal - anim.scale) * Math.min(1, dt * 6) : goal;
  const size = Math.max(0.0001, anim.scale * anim.radius);

  let sx = 1;
  let sy = 1;
  let flash = 0;
  if (motion && anim.kind !== "engine") {
    anim.wobbleAge += dt;
    const w = anim.wobble * Math.exp(-3 * anim.wobbleAge);
    const jelly = 0.12 * w * Math.sin(16 * anim.wobbleAge);
    const breathe = 0.02 * Math.sin(t * 1.4 + anim.phase);
    const breathe2 = 0.02 * Math.sin(t * 1.4 + anim.phase + Math.PI / 2);
    sx = 1 + jelly + breathe;
    sy = 1 - jelly + breathe2;
    flash = w;
    const amp = anim.kind === "provider" ? 1.5 : 0.8;
    anim.body.position.set(Math.cos(t * 0.4 + anim.phase) * amp * 0.5, Math.sin(t * 0.5 + anim.phase) * amp, 0);
    anim.body.position.addScaledVector(anim.pullDir, anim.pull * anim.radius * 0.3);
    sy += 0.06 * anim.pull;
    sx -= 0.03 * anim.pull;
  } else {
    anim.body.position.set(0, 0, 0);
  }
  anim.body.scale.set(size * sx, size * sy, size);

  // Focus fading: ease every material toward its resting opacity × fade.
  const fadeMoving = Math.abs(anim.fade - anim.fadeTarget) > 0.004;
  if (fadeMoving) anim.fade += (anim.fadeTarget - anim.fade) * Math.min(1, dt * 7);
  if (fadeMoving) {
    for (const { m, base } of anim.fadeables) m.opacity = base * anim.fade;
  }
  // The glow carries hover emphasis and the brief flash when a train leaves.
  if (anim.glow) {
    const boost = (anim.hovered ? 0.18 : 0) + 0.3 * flash;
    (anim.glow.material as THREE.SpriteMaterial).opacity = (anim.glowBase + boost) * anim.fade;
  }
  if (anim.alert) anim.alert.scale.setScalar(motion ? 2.5 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2.5)) : 2.7);
  anim.animate?.(t, dt, motion);
}

export function disposeNode(group: THREE.Object3D) {
  (group.userData.dispose as (() => void) | undefined)?.();
}

/** Stream states: normal (importance-weighted), lit (focus, turquoise) or dimmed (out of focus). */
export type StreamState = "normal" | "lit" | "dim";

/** A tube carrying trains of light from a node into the core. */
export function createStream(
  pool: ResourcePool,
  colorHex: string,
  width: number,
  rate: number,
  phase: number,
  opacity: number,
): THREE.Mesh {
  const material = pool.streamMaterial(colorHex, rate, phase, opacity);
  const mesh = new THREE.Mesh(pool.tube, material);
  noPick(mesh);
  mesh.userData.width = width;
  mesh.userData.rate = rate;
  mesh.userData.phase = phase;
  mesh.userData.opacity = opacity;
  mesh.userData.color = colorHex;
  mesh.userData.state = "normal";
  mesh.userData.dispose = () => pool.release(material);
  return mesh;
}

export function setStreamColor(mesh: THREE.Mesh, colorHex: string) {
  mesh.userData.color = colorHex;
  if (mesh.userData.state !== "lit") (mesh.material as THREE.ShaderMaterial).uniforms.uColor.value.set(colorHex);
}

export function setStreamState(mesh: THREE.Mesh, state: StreamState) {
  if (mesh.userData.state === state) return;
  mesh.userData.state = state;
  const u = (mesh.material as THREE.ShaderMaterial).uniforms;
  const base = mesh.userData.opacity as number;
  u.uOpacity.value = state === "lit" ? Math.min(0.9, base * 2.5 + 0.35) : state === "dim" ? base * 0.25 : base;
  u.uColor.value.set(state === "lit" ? THEME.teal : (mesh.userData.color as string));
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
