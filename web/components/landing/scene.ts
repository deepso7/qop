// "Harbour" hero art: a dithered pixel seascape behind the landing page's glass
// card. A sky graded down to the horizon (a day sky in light, night and stars
// in dark), a sun or moon with its path on the water, hazy hills, and a
// terracotta sea where two pale o peers float, joined by a dashed arc that a
// packet crosses. Every region is a run of shades in one ramp (see `tones`),
// so the dither only ever blends neighbouring shades of the same region.
import {
  hash,
  markDistance,
  noise,
  O_MARK,
  smoothstep,
  toneDither,
} from "./dither";

interface Palette {
  // Top of the sky down to the horizon; the last shade is the sun/moon disc.
  readonly sky: readonly string[];
  // Far mountains, then the nearer low islands.
  readonly hills: readonly [string, string];
  // Sea from the horizon to the foreground.
  readonly sea: readonly string[];
  // Peers, packet, glints and stars.
  readonly foam: string;
  // The dashed arc between the peers.
  readonly line: string;
  // How far the disc's glow spreads, in disc radii.
  readonly glow: number;
  readonly stars: boolean;
}

const PALETTES = {
  light: {
    sky: [
      "oklch(0.74 0.06 235)",
      "oklch(0.8 0.05 240)",
      "oklch(0.86 0.04 262)",
      "oklch(0.89 0.04 20)",
      "oklch(0.92 0.05 55)",
      "oklch(0.95 0.04 75)",
      "oklch(0.985 0.03 90)",
    ],
    hills: ["oklch(0.8 0.04 25)", "oklch(0.66 0.06 32)"],
    sea: [
      "oklch(0.806 0.067 56.1)",
      "oklch(0.705 0.094 52)",
      "oklch(0.609 0.112 46.7)",
      "oklch(0.49 0.1 44.8)",
      "oklch(0.374 0.079 42.7)",
    ],
    foam: "oklch(0.97 0.02 70)",
    line: "oklch(0.49 0.1 44.8)",
    glow: 7,
    stars: false,
  },
  dark: {
    sky: [
      "oklch(0.16 0.03 265)",
      "oklch(0.19 0.035 270)",
      "oklch(0.22 0.04 282)",
      "oklch(0.26 0.045 300)",
      "oklch(0.31 0.05 330)",
      "oklch(0.37 0.06 20)",
      "oklch(0.93 0.02 80)",
    ],
    hills: ["oklch(0.2 0.03 290)", "oklch(0.14 0.02 280)"],
    sea: [
      "oklch(0.46 0.082 48)",
      "oklch(0.374 0.058 47.6)",
      "oklch(0.306 0.035 47.6)",
      "oklch(0.249 0.023 45.9)",
      "oklch(0.2 0.015 45)",
    ],
    foam: "oklch(0.944 0.02 62.9)",
    line: "oklch(0.75 0.05 60)",
    glow: 1.2,
    stars: true,
  },
} satisfies Record<string, Palette>;

export type SceneMode = keyof typeof PALETTES;

// Seconds per send: TRAVEL crossing, then a pause.
const PERIOD = 6;
const TRAVEL = 4;

interface Pt {
  x: number;
  y: number;
}

interface Layout {
  // Horizon row, sun/moon centre and radius, all in cells.
  horizon: number;
  sun: Pt;
  r: number;
  // Mark scale, the two peers' top-left cells, and the arc as ordered cells.
  s: number;
  marks: readonly Pt[];
  path: Pt[];
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

// 1 for a wide (desktop) canvas, falling towards 0 as it gets taller than wide.
// Wide layouts keep the left for the glass card; tall ones keep the bottom.
const wideness = (w: number, h: number) => Math.min(1, w / h / 1.6);

// Rasterises a quadratic curve into a staircase of cells, so index = distance.
const staircase = (p0: Pt, c: Pt, p2: Pt) => {
  const path: Pt[] = [];

  for (let i = 0; i <= 2000; i += 1) {
    const u = i / 2000;

    const x = Math.round(
      (1 - u) ** 2 * p0.x + 2 * (1 - u) * u * c.x + u * u * p2.x
    );

    const y = Math.round(
      (1 - u) ** 2 * p0.y + 2 * (1 - u) * u * c.y + u * u * p2.y
    );

    const last = path.at(-1);

    if (last?.x === x && last.y === y) {
      continue;
    }

    // Drop the inner cell of an L-step so the line stays a clean staircase.
    const prev = path.at(-2);

    if (prev && Math.abs(prev.x - x) <= 1 && Math.abs(prev.y - y) <= 1) {
      path.pop();
    }

    path.push({ x, y });
  }

  return path;
};

const layout = (w: number, h: number): Layout => {
  const k = wideness(w, h);
  const horizon = Math.round(h * lerp(0.42, 0.6, k));
  const s = Math.max(2, Math.floor(Math.min(h / 80, w / 64)));

  // A peer's top-left cell, from its centre in fractions of the canvas
  // (u across, dv below the horizon), blended from portrait to landscape.
  const peer = (u0: number, u1: number, dv0: number, dv1: number) => ({
    x: Math.round(lerp(u0, u1, k) * w - 4 * s),
    y: Math.round(horizon + lerp(dv0, dv1, k) * h - 4 * s),
  });

  const a = peer(0.22, 0.56, 0.06, 0.07);
  const b = peer(0.76, 0.86, 0.04, 0.2);

  const path = staircase(
    { x: a.x + 7 * s + 1, y: a.y + 4 * s },
    { x: w * lerp(0.5, 0.74, k), y: horizon - h * lerp(0.3, 0.42, k) },
    { x: b.x + s - 1, y: b.y + 4 * s }
  );

  return {
    horizon,
    sun: { x: w * lerp(0.78, 0.22, k), y: h * lerp(0.13, 0.2, k) },
    r: Math.max(4, Math.min(w, h) * 0.05),
    s,
    marks: [a, b],
    path,
  };
};

type Paint = (x: number, y: number, color: string) => void;

// Paints a solid size x size square of cells.
const block = (
  paint: Paint,
  x: number,
  y: number,
  size: number,
  color: string
) => {
  for (let dy = 0; dy < size; dy += 1) {
    for (let dx = 0; dx < size; dx += 1) {
      paint(x + dx, y + dy, color);
    }
  }
};

// Mounts the scene onto a canvas in the given theme; returns a stop function.
export const scene = (canvas: HTMLCanvasElement, mode: SceneMode) => {
  const { sky, hills, sea, foam, line, glow, stars }: Palette = PALETTES[mode];

  // Tone numbers (1-based ramp indices) for each region.
  const ramp = [...sky, ...hills, ...sea];
  const DISC = sky.length;
  const FAR = DISC + 1;
  const NEAR = DISC + 2;
  const SEA = DISC + 3;
  const DEEP = SEA + sea.length - 1;

  let lay: Layout | undefined;
  let layW = -1;
  let layH = -1;

  // `field` runs for every cell every frame, so these helpers allocate nothing.
  const at = (w: number, h: number) => {
    if (!lay || layW !== w || layH !== h) {
      layW = w;
      layH = h;
      lay = layout(w, h);
    }

    return lay;
  };

  const nearMark = ({ s, marks }: Layout, x: number, y: number) => {
    let best = Infinity;

    for (const m of marks) {
      best = Math.min(best, markDistance((x - m.x) / s, (y - m.y) / s));
    }

    return best;
  };

  // Stars: single cells that twinkle, kept clear of the moon.
  const drawStars = (paint: Paint, l: Layout, t: number, w: number) => {
    for (let i = 0; i < 90; i += 1) {
      const x = Math.floor(hash(i, 11) * w);
      const y = Math.floor(hash(i, 12) * l.horizon * 0.8);
      const clear = Math.hypot(x - l.sun.x, y - l.sun.y) > l.r * 2;

      if (clear && Math.sin(t * (0.5 + hash(i, 13)) + i) > -0.2) {
        paint(x, y, foam);
      }
    }
  };

  // Glints: short pale dashes that flicker on the water, gathered into a path
  // below the sun or moon, and drifting slowly elsewhere.
  const drawGlints = (
    paint: Paint,
    l: Layout,
    t: number,
    w: number,
    h: number
  ) => {
    for (let i = 0; i < 140; i += 1) {
      const r = (k: number) => hash(i, k);
      const onPath = i < 80;
      const depth = onPath ? r(1) ** 1.6 : r(1);
      const y = l.horizon + 1 + Math.floor(depth * (h - l.horizon - 2));

      const x = onPath
        ? Math.floor(l.sun.x + (r(2) - 0.5) * (l.r * 1.5 + depth * w * 0.18))
        : Math.floor((((r(2) * w - t * (1 + r(3) * 2)) % w) + w) % w);

      if (
        Math.sin(t * (0.6 + r(4) * 0.8) + i * 2.1) < (onPath ? 0.1 : 0.6) ||
        nearMark(l, x, y) < 2
      ) {
        continue;
      }

      for (let k = 0; k < 2 + Math.floor(r(5) * (onPath ? 5 : 3)); k += 1) {
        paint(x + k, y, foam);
      }
    }
  };

  return toneDither(canvas, {
    cell: 4,
    ramp,
    field: (x, y, t, w, h) => {
      const l = at(w, h);

      if (y < l.horizon) {
        // Low islands in front of a hazy mountain range along the horizon.
        const island =
          0.04 * smoothstep(0.5, 0.8, noise(x * 0.018, 9.2)) +
          0.006 * noise(x * 0.2, 4.4);

        if (y > l.horizon - h * island) {
          return NEAR;
        }

        const ridge =
          0.02 +
          0.06 * noise(x * 0.011, 3.1) ** 1.5 +
          0.014 * noise(x * 0.05, 7.7);

        if (y > l.horizon - h * ridge) {
          return FAR;
        }

        const d = Math.hypot(x - l.sun.x, (y - l.sun.y) * 1.1) / l.r;

        if (d < 1) {
          return DISC;
        }

        // Sky graded down to the horizon, with slow drifting cloud bands.
        const kv = y / l.horizon;

        const cloud =
          (noise(x * 0.012 - t * 0.02, y * 0.09) - 0.5) *
          0.35 *
          smoothstep(0.15, 0.5, kv) *
          (1 - smoothstep(0.8, 1, kv));

        const g = Math.min(1, Math.max(0, kv ** 1.4 + cloud));
        const base = 1 + g * (DISC - 2);
        const halo = Math.max(0, 1 - (d - 1) / glow) ** 2;

        return Math.min(DISC - 0.05, base + halo * (DISC - base));
      }

      // A dark collar makes the pale marks read on any shade of water.
      if (nearMark(l, x, y) < 0.6) {
        return DEEP;
      }

      // Sea: lighter at the horizon, deeper towards the viewer, with sliding
      // horizontal streaks for the painted grain.
      const kd = (y - l.horizon) / (h - l.horizon);

      const streak =
        (noise(x * 0.02 - t * 0.08, y * 0.18) - 0.5) *
        2.4 *
        smoothstep(0, 0.15, kd);

      return Math.min(
        DEEP,
        Math.max(SEA, SEA + kd ** 0.8 * (sea.length - 1) + streak)
      );
    },
    overlay: (paint, t, w, h) => {
      const l = at(w, h);

      if (stars) {
        drawStars(paint, l, t, w);
      }

      drawGlints(paint, l, t, w, h);

      // The arc: two cells on, two off.
      for (const [i, p] of l.path.entries()) {
        if (i % 4 < 2) {
          paint(p.x, p.y, line);
        }
      }

      // The packet, offset so the still (reduced-motion) frame shows it mid-flight.
      const progress = ((t + 1.8) % PERIOD) / TRAVEL;

      if (progress <= 1) {
        const p = l.path[Math.round(progress * (l.path.length - 1))];

        block(paint, p.x - 1, p.y - 1, 3, foam);
      }

      // The peers, as solid pale bitmaps.
      for (const m of l.marks) {
        for (const [my, row] of O_MARK.entries()) {
          for (const [mx, c] of [...row].entries()) {
            if (c === "#") {
              block(paint, m.x + mx * l.s, m.y + my * l.s, l.s, foam);
            }
          }
        }
      }
    },
  });
};
