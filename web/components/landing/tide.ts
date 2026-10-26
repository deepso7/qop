// "Tide" hero art. A multi-shade terracotta tide washes in over bare
// paper from the top; two pale o peers float on it, joined by a dashed line a
// packet crosses, while short glints drift across the water.
import {
  hash,
  markDistance,
  noise,
  O_MARK,
  smoothstep,
  toneDither,
} from "./dither";

interface Palette {
  // Terracotta shades, shallow to deep (tones 1..6; tone 0 is the page).
  readonly ramp: readonly string[];
  // Marks, packet and glints.
  readonly foam: string;
  // The dashed arc between the peers.
  readonly line: string;
  // Tone of the collar around each mark, and of the foam lines near the shore.
  readonly collar: number;
  readonly surf: number;
}

// Light: deep water darkens against the paper. Dark: it glows against the page.
const PALETTES = {
  light: {
    ramp: [
      "oklch(0.889 0.037 58)",
      "oklch(0.806 0.067 56.1)",
      "oklch(0.705 0.094 52)",
      "oklch(0.609 0.112 46.7)",
      "oklch(0.49 0.1 44.8)",
      "oklch(0.374 0.079 42.7)",
    ],
    foam: "oklch(0.944 0.02 62.9)",
    line: "oklch(0.806 0.067 56.1)",
    collar: 6,
    surf: 0.8,
  },
  dark: {
    ramp: [
      "oklch(0.249 0.023 45.9)",
      "oklch(0.306 0.035 47.6)",
      "oklch(0.374 0.058 47.6)",
      "oklch(0.464 0.082 48.2)",
      "oklch(0.557 0.107 46.3)",
      "oklch(0.646 0.121 46.9)",
    ],
    foam: "oklch(0.944 0.02 62.9)",
    line: "oklch(0.889 0.037 58)",
    collar: 1,
    surf: 5.6,
  },
} satisfies Record<string, Palette>;

export type TideMode = keyof typeof PALETTES;

// Seconds per send: TRAVEL crossing, then a pause.
const PERIOD = 6;
const TRAVEL = 4;

interface Pt {
  x: number;
  y: number;
}

interface Scene {
  s: number;
  marks: readonly Pt[];
  path: Pt[];
}

// Water depth at normalised (u, v): positive in the tide, negative on the paper.
// The shoreline curves from high on the left to low on the right, breathing in
// and out with small ripples along it.
// `k` is how landscape the canvas is (see `wideness`): on a tall phone screen the
// shore flattens so the water stays above the copy instead of running down past it.
const depth = (u: number, v: number, t: number, k: number) =>
  0.32 +
  0.04 * (1 - k) +
  0.45 * k * u ** 1.6 -
  v +
  Math.sin(t * 0.45) * 0.018 +
  Math.sin(u * 12 + v * 5 - t * 0.9) * 0.01 +
  (noise(u * 7, v * 7 + t * 0.06) - 0.5) * 0.05;

// 1 for a wide (desktop) canvas, falling towards 0 as it gets taller than wide.
const wideness = (w: number, h: number) => Math.min(1, w / h / 1.6);

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

// Lays out the peers (in cells) and rasterises the arc between them into an
// ordered staircase of cells, so index = distance along the arc.
const build = (w: number, h: number): Scene => {
  const k = wideness(w, h);
  // Mark scale: sized by the shorter side so phones get smaller peers.
  const s = Math.max(2, Math.floor(Math.min(h / 48, w / 36)));

  // Peer positions blend from a portrait layout (k = 0) to the landscape one (k = 1).
  const centre = (u0: number, v0: number, u1: number, v1: number) => ({
    x: Math.round(lerp(u0, u1, k) * w - 4 * s),
    y: Math.round(lerp(v0, v1, k) * h - 4 * s),
  });

  const a = centre(0.26, 0.15, 0.5, 0.17);
  const b = centre(0.72, 0.3, 0.84, 0.38);
  const p0 = { x: a.x + 7 * s + 1, y: a.y + 4 * s };
  const p2 = { x: b.x + s - 1, y: b.y + 4 * s };
  const c = { x: w * lerp(0.62, 0.74, k), y: h * lerp(0.06, 0.1, k) };
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

  return { s, marks: [a, b], path };
};

// Mounts the tide onto a canvas in the given theme; returns a stop function.
export const tide = (canvas: HTMLCanvasElement, mode: TideMode) => {
  const { ramp, foam, line, collar, surf }: Palette = PALETTES[mode];
  let scene: Scene | undefined;
  let sceneW = -1;
  let sceneH = -1;

  // `field` runs for every cell every frame, so these helpers allocate nothing.
  const at = (w: number, h: number) => {
    if (!scene || sceneW !== w || sceneH !== h) {
      sceneW = w;
      sceneH = h;
      scene = build(w, h);
    }

    return scene;
  };

  const nearMark = ({ s, marks }: Scene, x: number, y: number) => {
    let best = Infinity;

    for (const m of marks) {
      best = Math.min(best, markDistance((x - m.x) / s, (y - m.y) / s));
    }

    return best;
  };

  return toneDither(canvas, {
    cell: 4,
    ramp,
    field: (x, y, t, w, h) => {
      const d = depth(x / w, y / h, t, wideness(w, h));

      // Wet sand just behind the wash, then bare paper for the copy.
      if (d < 0) {
        return smoothstep(-0.05, 0, d) * 0.7;
      }

      // A dark collar makes the pale marks read on any shade of water.
      if (nearMark(at(w, h), x, y) < 0.6) {
        return collar;
      }

      // Horizontal streaks, slowly sliding, give the water its painted grain.
      const streak =
        (noise(x * 0.02 - t * 0.1, y * 0.07) - 0.5) *
        2.6 *
        smoothstep(0, 0.12, d);

      const tone = 1.4 + smoothstep(0, 0.24, d) * 3.4 + streak;

      // Two broken surf lines ride just behind the shore, set apart from the water.
      const wash = Math.sin(t * 0.7 + x * 0.05) * 0.008;

      const band = 0.014 * noise(x * 0.08, t * 0.3);

      const onSurf =
        Math.abs(d - 0.012 - wash) < band || Math.abs(d - 0.05 - wash) < band;

      return onSurf ? surf : tone;
    },
    overlay: (paint, t, w, h) => {
      const sc = at(w, h);

      // Glints: short pale dashes that fade in and out and drift with the water.
      for (let i = 0; i < 48; i += 1) {
        const r = (k: number) => hash(i, k);

        const y = Math.floor(r(1) * h * 0.7);
        const x = Math.floor((((r(2) * w - t * (1 + r(3) * 2)) % w) + w) % w);

        if (Math.sin(t * (0.4 + r(4) * 0.6) + i * 2.1) < 0.55) {
          continue;
        }

        if (
          depth(x / w, y / h, t, wideness(w, h)) < 0.12 ||
          nearMark(sc, x, y) < 2
        ) {
          continue;
        }

        for (let k = 0; k < 2 + Math.floor(r(5) * 4); k += 1) {
          paint(x + k, y, foam);
        }
      }

      // The arc: two cells on, two off.
      for (const [i, p] of sc.path.entries()) {
        if (i % 4 < 2) {
          paint(p.x, p.y, line);
        }
      }

      // The packet, offset so the still (reduced-motion) frame shows it mid-flight.
      const progress = ((t + 1.8) % PERIOD) / TRAVEL;

      if (progress <= 1) {
        const p = sc.path[Math.round(progress * (sc.path.length - 1))];

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            paint(p.x + dx, p.y + dy, foam);
          }
        }
      }

      // The peers, as solid pale bitmaps.
      for (const m of sc.marks) {
        for (const [my, row] of O_MARK.entries()) {
          for (const [mx, c] of [...row].entries()) {
            if (c !== "#") {
              continue;
            }

            for (let dy = 0; dy < sc.s; dy += 1) {
              for (let dx = 0; dx < sc.s; dx += 1) {
                paint(m.x + mx * sc.s + dx, m.y + my * sc.s + dy, foam);
              }
            }
          }
        }
      }
    },
  });
};
