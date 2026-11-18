// Small noise helpers for the footer art (footer-art.ts).

// Cheap deterministic per-cell noise, used for paper speckle and shimmer.
export const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43_758.5453;

  return s - Math.floor(s);
};

// Smooth 2D value noise in 0..1, for tonal variation in a dithered surface.
export const noise = (x: number, y: number) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const top = hash(xi, yi) + (hash(xi + 1, yi) - hash(xi, yi)) * u;

  const bottom =
    hash(xi, yi + 1) + (hash(xi + 1, yi + 1) - hash(xi, yi + 1)) * u;

  return top + (bottom - top) * v;
};

export const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));

  return t * t * (3 - 2 * t);
};
