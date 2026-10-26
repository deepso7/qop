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
    ramp: ["#EED5C3", "#E2B596", "#CF8F68", "#B96C45", "#8E4C2D", "#63311C"],
    foam: "#F7EADF",
    line: "#E2B596",
    collar: 6,
    surf: 0.8,
  },
  dark: {
    ramp: ["#2B1E18", "#3E2A20", "#5A3725", "#7E4A2E", "#A65E3A", "#C9754A"],
    foam: "#F7EADF",
    line: "#EED5C3",
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
const depth = (u: number, v: number, t: number) =>
  0.32 +
  0.45 * u ** 1.6 -
  v +
  Math.sin(t * 0.45) * 0.018 +
  Math.sin(u * 12 + v * 5 - t * 0.9) * 0.01 +
  (noise(u * 7, v * 7 + t * 0.06) - 0.5) * 0.05;

// Lays out the peers (in cells) and rasterises the arc between them into an
// ordered staircase of cells, so index = distance along the arc.
const build = (w: number, h: number): Scene => {
  const s = Math.max(2, Math.floor(h / 48));

  const centre = (u: number, v: number) => ({
    x: Math.round(u * w - 4 * s),
    y: Math.round(v * h - 4 * s),
  });

  const a = centre(0.5, 0.17);
  const b = centre(0.84, 0.38);
  const p0 = { x: a.x + 7 * s + 1, y: a.y + 4 * s };
  const p2 = { x: b.x + s - 1, y: b.y + 4 * s };
  const c = { x: w * 0.74, y: h * 0.1 };
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
  let key = "";

  const at = (w: number, h: number) => {
    if (key !== `${w}x${h}` || !scene) {
      key = `${w}x${h}`;
      scene = build(w, h);
    }

    return scene;
  };

  const nearMark = ({ s, marks }: Scene, x: number, y: number) =>
    Math.min(...marks.map((m) => markDistance((x - m.x) / s, (y - m.y) / s)));

  return toneDither(canvas, {
    cell: 4,
    ramp,
    field: (x, y, t, w, h) => {
      const d = depth(x / w, y / h, t);

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

      const onSurf = [0.012, 0.05].some(
        (f) => Math.abs(d - f - wash) < 0.007 * noise(x * 0.08, t * 0.3) * 2
      );

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

        if (depth(x / w, y / h, t) < 0.12 || nearMark(sc, x, y) < 2) {
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
