import * as THREE from "three";

/**
 * Background atmosphere for the 3D network: a distant star field and a dense
 * cloud of glowing dust around the core. Purely decorative (no data).
 */

function dotTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const PALETTE = ["#ffffff", "#bcd8ff", "#7fb2ff", "#a58cff", "#d7c9ff"].map((c) => new THREE.Color(c));

/** Random points: on a shell (stars) or gathered toward the center (dust). */
function cloud(count: number, radius: number, centered: boolean): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.randomDirection();
    // Dust: density falls off with distance from the core; stars: a thick far shell.
    const r = centered ? radius * Math.pow(Math.random(), 2.2) : radius * (0.6 + 0.4 * Math.random());
    v.multiplyScalar(r);
    positions.set([v.x, v.y, v.z], i * 3);
    const c = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    colors.set([c.r, c.g, c.b], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export function createSpace() {
  const texture = dotTexture();
  const material = (size: number, opacity: number) =>
    new THREE.PointsMaterial({
      size,
      map: texture,
      vertexColors: true,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      fog: false,
    });

  const stars = new THREE.Points(cloud(3200, 4500, false), material(7, 0.75));
  const dust = new THREE.Points(cloud(2200, 520, true), material(3.4, 0.5));
  const group = new THREE.Group();
  group.add(stars, dust);

  return {
    group,
    /** Slow drift so the space feels alive. */
    update(t: number) {
      stars.rotation.y = t * 0.004;
      dust.rotation.y = -t * 0.02;
      dust.rotation.x = t * 0.008;
    },
    dispose() {
      for (const p of [stars, dust]) {
        p.geometry.dispose();
        (p.material as THREE.Material).dispose();
      }
      texture.dispose();
    },
  };
}
