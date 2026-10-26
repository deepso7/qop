// PROTOTYPE: throwaway ordered-dither renderer for the /prototype route.
// `field` returns ink density in 0..1 for a cell; a 4x4 Bayer matrix turns
// that into on/off pixels, drawn as squares with a 1px gap for the grid look.
// Returning SOLID instead fills the whole cell, for crisp shapes like the mark.

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

export const SOLID = 2;

export type Field = (x: number, y: number, t: number, w: number, h: number) => number;

export type DitherOptions = {
  readonly cell: number;
  readonly color: string;
  readonly field: Field;
  readonly animate?: boolean;
};

// Cheap deterministic per-cell noise, used for paper speckle and shimmer.
export const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
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
  const bottom = hash(xi, yi + 1) + (hash(xi + 1, yi + 1) - hash(xi, yi + 1)) * u;
  return top + (bottom - top) * v;
};

export const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Mounts a dither onto a canvas sized by CSS; returns a stop function.
export function dither(canvas: HTMLCanvasElement, { cell, color, field, animate = true }: DitherOptions) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let frame = 0;
  let cols = 0;
  let rows = 0;

  const resize = () => {
    const dpr = devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(canvas.clientWidth / cell);
    rows = Math.ceil(canvas.clientHeight / cell);
  };

  const draw = (now: number) => {
    const t = now / 1000;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    ctx.fillStyle = color;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const v = field(x, y, t, cols, rows);
        if (v >= SOLID) ctx.fillRect(x * cell, y * cell, cell, cell);
        else if (v > BAYER[(y % 4) * 4 + (x % 4)]) ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1);
      }
    }
    if (animate && !still) frame = requestAnimationFrame(draw);
  };

  const observer = new ResizeObserver(() => {
    resize();
    if (!animate || still) draw(0);
  });
  observer.observe(canvas);
  resize();
  frame = requestAnimationFrame(draw);

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}

// The qop "o" mark as an 8x8 bitmap (from mobile/assets/brand/qop-o.svg at 16px cells).
export const O_MARK = ["........", "..####..", ".######.", ".##..##.", ".##..##.", ".######.", "..####..", "........"];

// Distance from a point (in mark units, 0..8) to the nearest inked mark cell,
// read from a table sampled at 1/16 unit so per-frame fields stay cheap.
// Outside the table it is at least the mark's 1-unit empty border.
const RES = 16;
const SIZE = 8 * RES;
const table = new Float32Array(SIZE * SIZE);
for (let j = 0; j < SIZE; j++) {
  for (let i = 0; i < SIZE; i++) {
    let best = Infinity;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if (O_MARK[y][x] !== "#") continue;
        const dx = Math.max(Math.abs((i + 0.5) / RES - (x + 0.5)) - 0.5, 0);
        const dy = Math.max(Math.abs((j + 0.5) / RES - (y + 0.5)) - 0.5, 0);
        best = Math.min(best, Math.hypot(dx, dy));
      }
    }
    table[j * SIZE + i] = best;
  }
}

export function markDistance(mx: number, my: number) {
  const i = Math.floor(mx * RES);
  const j = Math.floor(my * RES);
  if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) return Infinity;
  return table[j * SIZE + i];
}
