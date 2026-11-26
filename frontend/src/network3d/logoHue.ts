/**
 * Family colours taken from provider logos: NVIDIA's green, Meta's blue… A provider and all its
 * models share the colour of its logo; providers without a colourful logo stay white.
 */

/** Colour for families with no logo, or a black-and-white one. */
export const PLAIN = "#F2F2F2";

/** provider name → display colour, filled in as logos load. */
export const familyHues = new Map<string, string>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/**
 * The logo's main colour, made to glow nicely on black: the most common saturated hue,
 * with lightness and saturation evened out so no family shouts louder than another.
 * Returns null for black-and-white or grey logos.
 */
export function dominantHue(img: CanvasImageSource): string | null {
  const size = 24;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, size, size);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null; // image not readable (no CORS): keep the plain colour
  }
  const bins = Array.from({ length: 12 }, () => ({ weight: 0, hue: 0, sat: 0 }));
  let colourful = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (s < 0.3 || l < 0.15 || l > 0.88) continue;
    colourful++;
    const bin = bins[Math.floor(h / 30) % 12];
    bin.weight += s;
    bin.hue += h * s;
    bin.sat += s * s;
  }
  // A logo needs a real share of coloured pixels, otherwise it reads as black and white.
  if (colourful < size * size * 0.06) return null;
  const top = bins.reduce((a, b) => (b.weight > a.weight ? b : a));
  const hue = top.hue / top.weight;
  const sat = Math.min(0.72, Math.max(0.45, top.sat / top.weight));
  return hslToHex(hue, sat, 0.64);
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}
