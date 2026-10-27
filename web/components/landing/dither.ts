// Multi-shade ordered-dither renderer for the landing page art.
// `field` returns a continuous tone per cell; a 4x4 Bayer matrix picks between
// the two nearest shades, drawn as squares with a 1px gap for the grid look.

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
  (v) => (v + 0.5) / 16
);

export type Field = (
  x: number,
  y: number,
  t: number,
  w: number,
  h: number
) => number;

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

export interface ToneOptions {
  readonly cell: number;
  // Shades from lightest to darkest. Tone 0 is the bare page; tone k is ramp[k - 1].
  readonly ramp: readonly string[];
  // Continuous tone in 0..ramp.length, ordered-dithered between neighbouring shades.
  readonly field: Field;
  // Solid, gapless cells drawn on top (marks, sprites, glints).
  readonly overlay?: (
    paint: (x: number, y: number, color: string) => void,
    t: number,
    cols: number,
    rows: number
  ) => void;
}

// Mounts a multi-shade dither onto a canvas sized by CSS, redrawn every frame
// while visible (once per resize under reduced motion); returns a stop function.
export const toneDither = (
  canvas: HTMLCanvasElement,
  { cell, ramp, field, overlay }: ToneOptions
) => {
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("2D canvas context unavailable");
  }

  // Reduced motion draws one still frame; followed live, so turning it on
  // while the page is open stops the animation (and turning it off resumes it).
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let still = motion.matches;
  // Off-screen (scrolled past) the loop pauses, so it costs nothing there.
  let visible = true;
  let frame = 0;

  const running = () => !still && visible;
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

  const paint = (x: number, y: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x * cell, y * cell, cell, cell);
  };

  const draw = (now: number) => {
    const t = now / 1000;

    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    // Bucket cells by shade so fillStyle changes once per shade, not per cell.
    const buckets: number[][] = ramp.map(() => []);

    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const v = Math.min(
          ramp.length,
          Math.max(0, field(x, y, t, cols, rows))
        );

        const lo = Math.floor(v);
        const tone = v - lo > BAYER[(y % 4) * 4 + (x % 4)] ? lo + 1 : lo;

        if (tone > 0) {
          buckets[tone - 1].push(y * cols + x);
        }
      }
    }

    for (const [i, cells] of buckets.entries()) {
      ctx.fillStyle = ramp[i];

      for (const c of cells) {
        ctx.fillRect(
          (c % cols) * cell,
          Math.floor(c / cols) * cell,
          cell - 1,
          cell - 1
        );
      }
    }

    overlay?.(paint, t, cols, rows);

    if (running()) {
      frame = requestAnimationFrame(draw);
    }
  };

  const observer = new ResizeObserver(() => {
    resize();

    if (still) {
      draw(0);
    }
  });

  // Restart the loop, or draw one still frame when motion is reduced.
  const restart = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(running() ? draw : () => draw(0));
  };

  const onMotionChange = () => {
    still = motion.matches;
    restart();
  };

  // Hiding just lets the loop stop on its next frame; showing restarts it.
  const visibility = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;

    if (visible) {
      restart();
    }
  });

  observer.observe(canvas);
  visibility.observe(canvas);
  motion.addEventListener("change", onMotionChange);
  resize();
  frame = requestAnimationFrame(draw);

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    visibility.disconnect();
    motion.removeEventListener("change", onMotionChange);
  };
};

// The qop "o" mark as an 8x8 bitmap (from mobile/assets/brand/qop-o.svg at 16px cells).
export const O_MARK = [
  "........",
  "..####..",
  ".######.",
  ".##..##.",
  ".##..##.",
  ".######.",
  "..####..",
  "........",
];

// Distance from a point (in mark units, 0..8) to the nearest inked mark cell,
// read from a table sampled at 1/16 unit so per-frame fields stay cheap.
const RES = 16;
const SIZE = 8 * RES;
const table = new Float32Array(SIZE * SIZE);

for (let j = 0; j < SIZE; j += 1) {
  for (let i = 0; i < SIZE; i += 1) {
    let best = Infinity;

    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        if (O_MARK[y][x] !== "#") {
          continue;
        }

        const dx = Math.max(Math.abs((i + 0.5) / RES - (x + 0.5)) - 0.5, 0);
        const dy = Math.max(Math.abs((j + 0.5) / RES - (y + 0.5)) - 0.5, 0);

        best = Math.min(best, Math.hypot(dx, dy));
      }
    }

    table[j * SIZE + i] = best;
  }
}

export const markDistance = (mx: number, my: number) => {
  const i = Math.floor(mx * RES);
  const j = Math.floor(my * RES);

  if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) {
    // Outside the table: approximate from the mark's centre.
    return Math.max(Math.hypot(mx - 4, my - 4) - 3, 0);
  }

  return table[j * SIZE + i];
};
