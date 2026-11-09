// "Stipple bay" footer art: a panoramic bay seen from a hillside, printed in
// one ink on bare paper. Two harbour towns face each other across the water
// (a near one on the left headland, a far one on the right), and a little
// sailboat drifts between them with nothing in the middle. Every cell gets a
// continuous ink density (0 = paper, 1 = solid), and a blue-noise threshold
// turns that into 1-bit dots, so tone comes only from dot density.
//
// The scene is composed once per size into a tone buffer; each frame only
// re-thresholds it with a slow shimmer on the water and redraws the boat.
import { hash, noise, smoothstep } from "./landing/dither";

// Cell kinds: sky (the default), land, and water, which the frame loop shimmers.
const LAND = 1;
const WATER = 2;
const INK = 0xff_00_00_00;

// ---------------------------------------------------------------------------
// Blue noise: a 64x64 threshold map built once by void-and-cluster style
// ranking (always fill the emptiest spot next), which spreads dots evenly
// with no grid pattern, like stipple.

const BN = 64;
let blueNoise: Float32Array | undefined;

const buildBlueNoise = () => {
  const n = BN * BN;
  const energy = new Float32Array(n);
  const rank = new Float32Array(n);
  const taken = new Uint8Array(n);
  const r = 5;
  const kernel: number[] = [];

  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      kernel.push(Math.exp(-(dx * dx + dy * dy) / (2 * 1.6 * 1.6)));
    }
  }

  // A whisper of deterministic jitter breaks ties without a visible pattern.
  for (let i = 0; i < n; i += 1) {
    energy[i] = hash(i % BN, Math.floor(i / BN)) * 1e-3;
  }

  for (let k = 0; k < n; k += 1) {
    let best = -1;
    let low = Infinity;

    for (let i = 0; i < n; i += 1) {
      if (!taken[i] && energy[i] < low) {
        low = energy[i];
        best = i;
      }
    }

    taken[best] = 1;
    rank[best] = (k + 0.5) / n;

    const bx = best % BN;
    const by = Math.floor(best / BN);
    let j = 0;

    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        energy[((by + dy + BN) % BN) * BN + ((bx + dx + BN) % BN)] += kernel[j];
        j += 1;
      }
    }
  }

  return rank;
};

// ---------------------------------------------------------------------------
// The geography. Positions are in scene units: u runs 0..1 across a virtual
// panorama (cropped at the sides on narrow screens), v runs 0..1 down the art.

const HORIZON = 0.25;

// Where the far shore turns from the town's point into the long beach.
const POINT = 0.345;

// Harbour mouths the boat sails between: the near town, then the far one.
const NEAR_HARBOUR = { u: 0.345, v: 0.47 };
const FAR_HARBOUR = { u: 0.675, v: 0.365 };
const MOON_U = 0.56;

type Region = (u: number, v: number) => boolean;

// Top edge of the near (left) headland, falling to its tip over the water.
const ridgeNear = (u: number) =>
  0.05 + 0.37 * smoothstep(0.04, 0.33, u) ** 1.4 + 0.02 * noise(u * 30, 1);

// The near headland's waterline: a ragged bluff that drifts right as it nears.
const shoreNear = (v: number) =>
  0.325 +
  0.06 * smoothstep(0.45, 1, v) +
  0.012 * Math.sin(v * 40) +
  0.01 * noise(v * 25, 4);

// Top edge of the far (right) hills, falling to the far town's point.
const ridgeFar = (u: number) =>
  0.125 + 0.22 * (1 - smoothstep(0.66, 1, u)) ** 1.6 + 0.015 * noise(u * 34, 7);

// The far waterline below the point: it bulges out, then sweeps back toward
// the viewer as the long curving beach. Above the point there is none.
const shoreFar = (v: number) => {
  if (v <= POINT) {
    return 2;
  }

  const d = v - POINT;

  return 0.665 + 0.75 * d - 1.92 * d * d;
};

const beachWidth = (v: number) => 0.012 + 0.11 * Math.max(0, v - POINT);

const onNear: Region = (u, v) =>
  v > ridgeNear(u) + 0.02 && u < shoreNear(v) - 0.006;

const onFar: Region = (u, v) =>
  v > ridgeFar(u) + 0.015 && (v < POINT ? u > 0.66 : u > shoreFar(v) + 0.015);

// Upper edges of our own foreground slopes, in the bottom corners.
const fgLeft = (u: number) => 0.7 + 0.45 * smoothstep(0, 0.42, u) ** 1.3;
const fgRight = (u: number) => 0.8 + 0.4 * (1 - smoothstep(0.66, 1, u)) ** 1.4;

const fgDepth = (u: number, v: number) =>
  Math.max(v - fgLeft(u), v - fgRight(u));

// ---------------------------------------------------------------------------
// The tone buffer and the painters that fill it, back to front.

interface Grid {
  readonly cols: number;
  readonly rows: number;
  readonly tone: Float32Array;
  readonly kind: Uint8Array;
  // Sprite scale: sizes are tuned for 140 rows and grow with the art.
  readonly s: number;
  readonly uOf: (x: number) => number;
  readonly toCell: (u: number, v: number) => readonly [number, number];
  readonly put: (x: number, y: number, t: number, k?: number) => void;
}

const makeGrid = (cols: number, rows: number): Grid => {
  const tone = new Float32Array(cols * rows);
  const kind = new Uint8Array(cols * rows);
  // Narrow screens show the middle of a wider panorama instead of squashing it.
  const span = Math.max(cols, rows * 1.75);
  const offset = (span - cols) / 2;

  return {
    cols,
    rows,
    tone,
    kind,
    s: rows / 140,
    uOf: (x) => (x + offset) / span,
    toCell: (u, v) => [Math.round(u * span - offset), Math.round(v * rows)],
    put: (x, y, t, k = LAND) => {
      if (x >= 0 && y >= 0 && x < cols && y < rows) {
        tone[y * cols + x] = t;
        kind[y * cols + x] = k;
      }
    },
  };
};

// Night sky: scattered stars and a crescent moon.
const paintNight = ({ cols, rows, s, toCell, put }: Grid) => {
  for (let y = 0; y < HORIZON * rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (hash(x * 1.7, y * 3.1) > 0.993 - (y / rows) * 0.01) {
        put(x, y, 1, 0);
      }
    }
  }

  const [mx, my] = toCell(MOON_U, 0.1);
  const mr = Math.round(6 * s);

  for (let y = -mr; y <= mr; y += 1) {
    for (let x = -mr; x <= mr; x += 1) {
      // The disc minus a disc nudged toward the upper right.
      if (
        Math.hypot(x, y) <= mr &&
        Math.hypot(x - mr * 0.45, y + mr * 0.25) > mr * 0.85
      ) {
        put(mx + x, my + y, 1, 0);
      }
    }
  }
};

// Day sky: three gulls.
const paintGulls = ({ s, toCell, put }: Grid) => {
  for (const [gu, gv, gs] of [
    [0.47, 0.08, 1],
    [0.5, 0.12, 0.8],
    [0.53, 0.06, 0.7],
  ] as const) {
    const [gx, gy] = toCell(gu, gv);
    const w = Math.max(2, Math.round(3 * s * gs));

    for (let i = 1; i <= w; i += 1) {
      const lift = Math.round(Math.sin((i / w) * Math.PI * 0.9) * (w / 2.5));

      put(gx - i, gy - lift + 1, 1, 0);
      put(gx + i, gy - lift + 1, 1, 0);
    }

    put(gx, gy + 1, 1, 0);
  }
};

// The near headland, lit from the upper left: density climbs toward the
// waterline, mottled by scrub and crossed by terrace lines.
const nearHillTone = (x: number, y: number, u: number, v: number) => {
  const slope =
    smoothstep(0.1, 0.45, v) * 0.08 + smoothstep(0.24, 0.33, u) * 0.1;

  const scrub = smoothstep(0.55, 0.75, noise(x * 0.09, y * 0.16)) * 0.3;
  const terrace = Math.sin(y * 0.55 + noise(x * 0.03, 2) * 5) > 0.93 ? 0.3 : 0;

  return 0.01 + slope * 0.7 + scrub * 0.8 + terrace;
};

// The far hills above the point, a little darker toward the right edge.
const farHillTone = (x: number, y: number, u: number) =>
  0.1 +
  smoothstep(0.5, 0.75, noise(x * 0.12, y * 0.22)) * 0.3 +
  smoothstep(0.8, 1, u) * 0.06;

// Behind the far waterline: pale sand with a darker wet band and the thin
// line of the promenade wall, then the hillside (olive groves go on top).
const farShoreTone = (x: number, y: number, u: number, v: number) => {
  const f = (u - shoreFar(v)) / beachWidth(v);

  if (f < 1) {
    const wet = 1 - smoothstep(0, 0.22, f);
    const wall = f > 0.92 ? 0.45 : 0;

    return 0.03 + wet * 0.3 + wall + noise(x * 0.3, y * 0.3) * 0.05;
  }

  const patch = noise(x * 0.16, y * 0.3) > 0.64 ? 0.15 : 0;

  return (
    0.06 +
    smoothstep(0.35, 0.8, v) * 0.1 +
    noise(x * 0.1, y * 0.18) * 0.08 +
    patch
  );
};

// Open water: hazy at the horizon, dense ink by mid-bay, lighter over the
// shallows, with foam at the beach and, at night, a broken moon path.
const waterTone = (
  x: number,
  y: number,
  u: number,
  v: number,
  dark: boolean
) => {
  const shore = shoreFar(v);

  if (shore - u < 0.004 + 0.006 * (v - POINT)) {
    return 0.02;
  }

  const depth = smoothstep(HORIZON, 0.46, v);
  const shallowFar = 1 - smoothstep(0, 0.045, shore - u);
  const shallowNear = 1 - smoothstep(0, 0.02, u - shoreNear(v));
  const streak = noise(x * 0.03, y * 0.7) * 0.08;

  const tone =
    0.58 + depth * 0.44 - shallowFar * 0.55 - shallowNear * 0.3 - streak;

  if (!dark || noise(x * 0.18, y * 1.7) <= 0.55) {
    return tone;
  }

  const path = Math.abs(u - MOON_U) / (0.003 + (v - HORIZON) * 0.06);

  return tone + (1 - smoothstep(0.2, 1, path)) * 0.5;
};

// Land, beach and water, cell by cell, then an engraver's contour line
// wherever land meets sky or water.
const paintTerrain = ({ cols, rows, tone, kind, uOf }: Grid, dark: boolean) => {
  for (let y = 0; y < rows; y += 1) {
    const v = (y + 0.5) / rows;

    for (let x = 0; x < cols; x += 1) {
      const u = uOf(x + 0.5);
      const i = y * cols + x;

      kind[i] = LAND;

      if (v > ridgeNear(u) && u < shoreNear(v)) {
        tone[i] = nearHillTone(x, y, u, v);
      } else if (u > 0.6 && v > ridgeFar(u) && v < POINT) {
        tone[i] = farHillTone(x, y, u);
      } else if (v >= HORIZON && u > shoreFar(v)) {
        tone[i] = farShoreTone(x, y, u, v);
      } else if (v >= HORIZON) {
        tone[i] = waterTone(x, y, u, v, dark);
        kind[i] = WATER;
      } else {
        kind[i] = 0;
      }
    }
  }

  for (let y = 1; y < rows; y += 1) {
    for (let x = 1; x < cols - 1; x += 1) {
      const i = y * cols + x;

      if (
        kind[i] === LAND &&
        (kind[i - cols] !== LAND ||
          kind[i - 1] !== LAND ||
          kind[i + 1] !== LAND)
      ) {
        tone[i] = 1;
      }
    }
  }
};

// A shaded, roughly round blob (tree crown, bush): darker away from the
// upper-left light, with a ragged edge and a paper halo when `halo`.
const blob = (
  { put }: Grid,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  base: number,
  halo = false
) => {
  const pad = halo ? 1.5 : 0;

  for (let y = Math.floor(cy - ry - pad); y <= cy + ry + pad; y += 1) {
    for (let x = Math.floor(cx - rx - pad); x <= cx + rx + pad; x += 1) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const d = Math.hypot(dx, dy) + (noise(x * 0.5, y * 0.5) - 0.5) * 0.35;

      if (d <= 1) {
        put(
          x,
          y,
          base + (dx + dy) * 0.25 + (noise(x * 0.7, y * 0.9) - 0.5) * 0.3
        );
      } else if (halo && d <= 1 + pad / Math.min(rx, ry)) {
        put(x, y, 0);
      }
    }
  }
};

// A cypress: a dark flame, pointed at the top, lit on its left flank.
const cypress = ({ put }: Grid, cx: number, base: number, h: number) => {
  const w = Math.max(1.5, h * 0.13);

  for (let y = Math.floor(base - h); y <= base; y += 1) {
    const f = (y - (base - h)) / h;

    const half = Math.max(
      0.5,
      w * Math.sin(Math.min(1, f * 1.15) * Math.PI * 0.62) ** 0.8
    );

    for (let x = Math.floor(cx - half) - 1; x <= cx + half + 1; x += 1) {
      const d = (x - cx) / half;

      if (Math.abs(d) <= 1) {
        put(x, y, 0.78 + d * 0.22 + (noise(x * 0.8, y * 0.6) - 0.5) * 0.3);
      } else if (Math.abs(d) <= 1 + 1.2 / half) {
        put(x, y, 0);
      }
    }
  }
};

type Roof = "flat" | "pitch" | "dome";

// Roofs, drawn above a house's top row.
const ROOFS: Record<
  Roof,
  (g: Grid, x0: number, top: number, w: number) => void
> = {
  // An overhanging ink cap over a hatched parapet.
  flat: ({ put }, x0, top, w) => {
    for (let x = x0 - 2; x <= x0 + w + 1; x += 1) {
      put(x, top - 1, 1);
      put(x, top, x > x0 - 2 && x < x0 + w + 1 ? 0.7 : 0);
    }
  },
  // A low terracotta gable.
  pitch: ({ put }, x0, top, w) => {
    for (let r = 0; r <= Math.ceil(w / 2); r += 1) {
      for (let x = x0 - 1 + r; x <= x0 + w - r; x += 1) {
        put(x, top - 1 - Math.floor(r / 1.6), 0.9);
      }
    }
  },
  // A dome, lit on the left.
  dome: ({ put }, x0, top, w) => {
    const rad = w / 2;

    for (let y = 0; y <= rad; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) {
        if (Math.hypot(x + 0.5 - (x0 + rad), y) <= rad) {
          put(x, top - y, x > x0 + rad ? 0.85 : 0.55);
        }
      }
    }
  },
};

// A pixel house, outlined in ink: paper walls lit from the left, a hatched
// shadow face and cast shadow on the right, ink windows and a roof.
const house = (
  g: Grid,
  x0: number,
  base: number,
  w: number,
  h: number,
  roof: Roof,
  seed: number
) => {
  const { put } = g;
  const top = base - h;
  const shadow = x0 + w - Math.max(1, Math.round(w * 0.3));
  const cast = Math.max(1, Math.round(w * 0.35));

  // Clear a paper margin, with the cast shadow falling to the right.
  for (let y = top - 1; y <= base + 1; y += 1) {
    for (let x = x0 - 2; x <= x0 + w + cast; x += 1) {
      put(x, y, x > x0 + w && y > top + h * 0.3 ? 0.8 : 0);
    }
  }

  for (let y = top; y <= base; y += 1) {
    for (let x = x0 - 1; x <= x0 + w; x += 1) {
      put(x, y, x >= shadow ? 0.62 : 0);
    }

    put(x0 - 1, y, 1);
    put(x0 + w, y, 1);
  }

  for (let x = x0 - 1; x <= x0 + w; x += 1) {
    put(x, base, 1);
  }

  // Windows on a 2-cell grid, some shuttered (missing), and a door.
  if (w >= 3 && h >= 3) {
    for (let y = top + 2; y < base - 1; y += 2) {
      for (let x = x0 + 1; x < x0 + w - 1; x += 2) {
        if (hash(x + seed, y) > 0.3) {
          put(x, y, 1);
        }
      }
    }

    put(x0 + Math.floor(w / 2) - (w > 4 ? 1 : 0), base - 1, 1);
  }

  ROOFS[roof](g, x0, top, w);
};

const roofFor = (r: number, size: number): Roof => {
  if (r > 0.55) {
    return "pitch";
  }

  return r > 0.5 && size > 1 ? "dome" : "flat";
};

// A town: rows of houses between `from` and `to`, each row's base at a v in
// `rowsV`; `land` keeps every house on its own hillside.
const town = (
  g: Grid,
  from: number,
  to: number,
  rowsV: readonly number[],
  size: number,
  land: Region,
  seed: number
) => {
  for (const [ri, rv] of rowsV.entries()) {
    const [, base] = g.toCell(0, rv);
    const [x1] = g.toCell(to, 0);
    let [x] = g.toCell(from, 0);

    while (x < x1) {
      const r = hash(x * 0.37 + seed, ri * 7.1 + seed);
      const w = Math.max(2, Math.round((3 + r * 4) * size));

      const h = Math.max(
        2,
        Math.round((2.5 + hash(x, ri + seed) * 3.5) * size)
      );

      const jitter = Math.round((hash(x + 3, ri) - 0.5) * 2 * size);

      if (r <= 0.12) {
        // A gap in the row becomes a garden tree.
        blob(g, x + 1.5 * size, base - 1.5 * size, 2 * size, 2 * size, 0.7);
      } else if (
        land(g.uOf(x), (base - h) / g.rows) &&
        land(g.uOf(x + w), base / g.rows)
      ) {
        house(g, x, base + jitter, w, h, roofFor(r, size), seed);
      }

      x += w + 1 + Math.round(hash(x, seed) * 2 * size);
    }
  }
};

// Clumps of trees along both ridge lines.
const paintRidgeTrees = (g: Grid) => {
  const { cols, s, uOf, toCell } = g;

  for (let x = 0; x < cols; x += 1) {
    const u = uOf(x);
    const r = hash(x * 0.71, 3);

    if (u > 0.63 && r > 0.82) {
      blob(
        g,
        x,
        toCell(0, ridgeFar(u))[1] + 1,
        (1.2 + r) * s,
        (1.2 + r * 1.3) * s,
        0.62
      );
    }

    if (u < 0.3 && r > 0.85) {
      blob(
        g,
        x,
        toCell(0, ridgeNear(u))[1] + 1,
        (1.6 + r * 1.4) * s,
        (1.6 + r * 1.6) * s,
        0.66
      );
    }
  }
};

// Olive groves: rows of round trees that grow as they come toward us.
const grove = (g: Grid, from: number, to: number, land: Region) => {
  for (let rv = from; rv < to; rv += 0.03 + (rv - 0.4) * 0.1) {
    const size = (1.1 + (rv - 0.4) * 6) * g.s;
    const [, y] = g.toCell(0, rv);

    for (let x = 0; x < g.cols; x += Math.max(3, Math.round(size * 3))) {
      const jx = Math.round((hash(x, rv * 50) - 0.5) * size);

      if (land(g.uOf(x + jx), rv) && hash(x * 0.3, rv * 9) > 0.15) {
        blob(g, x + jx, y, size, size * 0.8, 0.82, true);
      }
    }
  }
};

// The far side: small houses stacked behind the point, villas along the
// beach, cypresses, a bell tower, a short mole for the boat and the groves
// on the hillside behind the beach.
const paintFarTown = (g: Grid) => {
  const { s, toCell, put } = g;

  town(g, 0.665, 0.99, [0.235, 0.27, 0.305, 0.34], 0.75 * s, onFar, 11);
  town(g, 0.78, 0.99, [0.4, 0.46], 0.9 * s, onFar, 13);

  for (const cu of [0.72, 0.86, 0.93]) {
    const [cx, cy] = toCell(cu, 0.22);

    cypress(g, cx, cy, 6 * s);
  }

  const [tx, ty] = toCell(0.7, POINT);

  house(g, tx, ty, Math.round(3 * s), Math.round(10 * s), "pitch", 5);

  const [mx, my] = toCell(FAR_HARBOUR.u - 0.004, FAR_HARBOUR.v - 0.008);

  for (let x = mx; x < mx + 7 * s; x += 1) {
    put(x, my, 0.05);
    put(x, my + 1, 0.6);
  }

  grove(
    g,
    0.5,
    0.95,
    (u, v) => onFar(u, v) && v > POINT && u > shoreFar(v) + beachWidth(v) + 0.02
  );
};

// A striped lighthouse with an ink lantern, its base at (lx, ly).
const lighthouse = ({ s, put }: Grid, lx: number, ly: number) => {
  const lw = Math.max(2, Math.round(3 * s));
  const lh = Math.round(14 * s);
  const stripe = Math.max(2, Math.round(3 * s));

  for (let y = ly - lh - 1; y <= ly; y += 1) {
    for (let x = lx - 1; x <= lx + lw; x += 1) {
      put(x, y, 0);
    }
  }

  for (let y = ly - lh; y < ly; y += 1) {
    const band = Math.floor((ly - y) / stripe) % 2 === 1;

    for (let x = lx; x < lx + lw; x += 1) {
      put(x, y, band ? 0.9 : 0.04);
    }

    // The shaded right edge of the white bands.
    if (!band) {
      put(lx + lw - 1, y, 0.4);
    }
  }

  for (let x = lx - 1; x <= lx + lw; x += 1) {
    put(x, ly - lh - 1, 1);
    put(x, ly - lh - 3, 1);
  }

  put(lx - 1, ly - lh - 2, 1);
  put(lx + lw, ly - lh - 2, 1);
};

// The near side: groves below, bigger houses terraced down to a quay,
// cypresses, a church dome and the lighthouse on the point.
const paintNearTown = (g: Grid) => {
  const { s, toCell, put } = g;

  grove(g, 0.53, 0.95, (u, v) => onNear(u, v) && u < shoreNear(v) - 0.03);
  town(
    g,
    0.1,
    0.33,
    [0.19, 0.25, 0.31, 0.37, 0.43, 0.49],
    1.25 * s,
    onNear,
    21
  );
  town(g, 0.02, 0.14, [0.13, 0.18], 1.1 * s, onNear, 23);

  for (const cu of [0.06, 0.15, 0.24]) {
    const [cx, cy] = toCell(cu, 0.17 + cu * 0.4);

    cypress(g, cx, cy, 11 * s);
  }

  const [qx, qy] = toCell(NEAR_HARBOUR.u - 0.03, NEAR_HARBOUR.v + 0.01);

  for (let x = qx; x < qx + 12 * s; x += 1) {
    put(x, qy, 0.04);
    put(x, qy + 1, 0.04);
    put(x, qy + 2, 0.75);
  }

  lighthouse(g, ...toCell(0.318, 0.43));

  const [dx, dy] = toCell(0.2, 0.3);

  house(g, dx, dy, Math.round(7 * s), Math.round(7 * s), "dome", 9);
};

// A stone pine rooted on our slope, its flat dark crown against the sky.
const pine = (
  g: Grid,
  root: readonly [number, number],
  crown: readonly [number, number]
) => {
  const { s, put } = g;
  const [rx, ry] = g.toCell(...root);
  const [cx, cy] = g.toCell(...crown);
  const tw = Math.max(2, Math.round(2.4 * s));

  for (let y = cy; y <= ry; y += 1) {
    const f = (y - cy) / Math.max(1, ry - cy);
    const x = Math.round(cx + (rx - cx) * f ** 0.7 + Math.sin(f * 4) * 2 * s);
    // The trunk thickens toward the root; its lit left edge is hatched.
    const width = tw + Math.round(f * f * tw);

    for (let dx = 0; dx < width; dx += 1) {
      put(x + dx, y, dx === 0 ? 0.45 : 1);
    }

    put(x - 1, y, 0);
    put(x + width, y, 0);
  }

  // The crown: overlapping flat clumps, widest at the top.
  const w = 46 * s;
  const h = 8 * s;

  for (const [ox, oy, sx, sy] of [
    [-0.5, 0.55, 0.42, 0.8],
    [0.55, 0.5, 0.42, 0.75],
    [0, 0, 1, 1],
    [-0.25, -0.45, 0.55, 0.75],
    [0.3, -0.3, 0.5, 0.7],
  ] as const) {
    blob(g, cx + ox * w * 0.6, cy + oy * h, (w / 2) * sx, h * sy, 0.84, true);
  }
};

// A pale five-petal rosette with an ink heart.
const flower = ({ put }: Grid, fx: number, fy: number, r: number) => {
  for (let y = -r - 1; y <= r + 1; y += 1) {
    for (let x = -r - 1; x <= r + 1; x += 1) {
      const d = Math.hypot(x, y);
      const petal = r * (0.65 + 0.35 * Math.cos(Math.atan2(y, x) * 5));

      if (d <= petal) {
        put(fx + x, fy + y, d < r * 0.3 ? 0.95 : 0.02);
      } else if (d <= petal + 1) {
        put(fx + x, fy + y, 0.8);
      }
    }
  }
};

// Our own hillside in both bottom corners: a stone pine, a mottled mass of
// undergrowth, shaded bushes along its edge, two cypresses and flowers.
const paintForeground = (g: Grid) => {
  const { cols, rows, s, tone, kind, uOf, toCell } = g;

  pine(g, [0.935, 1], [0.885, 0.13]);

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const depth = fgDepth(uOf(x + 0.5), (y + 0.5) / rows);

      if (depth > 0) {
        const leaf = noise(x * 0.25, y * 0.35) * 0.35 + noise(x * 0.8, y) * 0.2;

        tone[y * cols + x] = 0.18 + leaf + smoothstep(0, 0.25, depth) * 0.3;
        kind[y * cols + x] = LAND;
      }
    }
  }

  for (let x = -20; x < cols + 20; x += Math.round(5 * s)) {
    const top = Math.min(fgLeft(uOf(x)), fgRight(uOf(x)));
    const r = hash(x * 0.13, 17);

    if (top < 1.04) {
      blob(
        g,
        x,
        toCell(0, top + 0.02)[1],
        (5 + r * 7) * s,
        (4 + r * 5) * s,
        0.78 + r * 0.1,
        true
      );
    }
  }

  for (const [cu, h] of [
    [0.025, 0.5],
    [0.058, 0.36],
  ] as const) {
    const [cx, cy] = toCell(cu, fgLeft(cu) + 0.06);

    cypress(g, cx, cy, h * rows);
  }

  for (let k = 0; k < 260; k += 1) {
    const u = hash(k, 41);
    const v = 0.65 + 0.35 * hash(u * 91.3, k * 3.7);
    const inside = fgDepth(u, v);

    if (inside > 0.03) {
      flower(
        g,
        ...toCell(u, v),
        Math.max(1, Math.round((1 + hash(k, 47) * 1.5 + inside * 5) * s))
      );
    }
  }
};

const compose = (cols: number, rows: number, dark: boolean) => {
  const g = makeGrid(cols, rows);

  if (dark) {
    paintNight(g);
  } else {
    paintGulls(g);
  }

  paintTerrain(g, dark);
  paintRidgeTrees(g);
  paintFarTown(g);
  paintNearTown(g);
  paintForeground(g);

  return g;
};

// ---------------------------------------------------------------------------
// Rendering.

// The boat ping-pongs between the harbours, easing in and out of each.
const boatAt = (t: number) => {
  const phase = (t / 48) % 2;
  const s = (1 - Math.cos(Math.PI * (phase < 1 ? phase : 2 - phase))) / 2;

  const u =
    NEAR_HARBOUR.u + 0.015 + (FAR_HARBOUR.u - NEAR_HARBOUR.u - 0.03) * s;

  const v =
    NEAR_HARBOUR.v +
    (FAR_HARBOUR.v - NEAR_HARBOUR.v) * s +
    0.07 * Math.sin(Math.PI * s);

  return { u, v, heading: phase < 1 ? 1 : -1, speed: Math.sin(Math.PI * s) };
};

// Thresholds the tone buffer into 1-bit pixels, with drifting wave crests
// (thin pale dashes) on the water.
const dither = (
  { cols, rows, tone, kind }: Grid,
  px: Uint32Array,
  threshold: Float32Array,
  t: number,
  dark: boolean
) => {
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const i = y * cols + x;
      let v = tone[i];

      // Pale ink on dark paper reads heavier, so ease the dense tones back
      // (solid ink, the contours and outlines, stays solid).
      if (dark && v < 1) {
        v *= 0.8;
      }

      if (kind[i] === WATER) {
        const crest =
          noise(x * 0.06 + t * 0.35, y * 0.75) *
          noise(x * 0.11 - t * 0.2, y * 0.75 + 40);

        v -= smoothstep(0.32, 0.55, crest) * 0.55 * (0.4 + (y / rows) * 0.8);
      }

      px[i] = v > threshold[(y % BN) * BN + (x % BN)] ? INK : 0;
    }
  }
};

// The boat: a pale hull and sails knocked out of the water, an ink mast,
// pennant and waterline, and a short wake fanning out behind.
const drawBoat = ({ cols, rows, toCell }: Grid, px: Uint32Array, t: number) => {
  const { u, v, heading, speed } = boatAt(t);
  const [bx, by] = toCell(u, v);
  const k = Math.max(1, Math.round(rows / 140));

  const set = (x: number, y: number, ink: boolean) => {
    if (x >= 0 && y >= 0 && x < cols && y < rows) {
      px[y * cols + x] = ink ? INK : 0;
    }
  };

  for (let w = 1; w < 14 * k * (0.3 + speed); w += 1) {
    if (hash(w, Math.floor(t * 3)) > 0.35) {
      set(bx - heading * (4 * k + w), by + 1 + Math.round(w / 5), false);
      set(bx - heading * (4 * k + w), by + 1 - Math.round(w / 7), false);
    }
  }

  for (let y = -10 * k; y <= 3 * k; y += 1) {
    for (let x = -6 * k; x <= 6 * k; x += 1) {
      const hull = y >= 0 && y <= 2 * k && Math.abs(x) <= 5 * k - y;

      const sail =
        y < 0 &&
        y >= -8 * k &&
        x * heading >= 0 &&
        Math.abs(x) <= (8 * k + y) * 0.55;

      const jib =
        y < -1 &&
        y >= -6 * k &&
        x * heading < 0 &&
        Math.abs(x) <= (6 * k + y) * 0.35;

      if (hull || sail || jib) {
        set(bx + x, by + y, false);
      }
    }
  }

  for (let y = -9 * k; y <= 0; y += 1) {
    set(bx, by + y, true);
  }

  set(bx + heading, by - 9 * k, true);
  set(bx + heading * 2, by - 9 * k, true);

  for (let x = -4 * k; x <= 4 * k; x += 1) {
    set(bx + x, by + 2 * k, true);
  }
};

interface Options {
  readonly dark: boolean;
}

// Mounts the art onto a canvas sized by CSS, in the canvas's CSS `color`. It
// animates (water shimmer, boat) while on screen and draws one still frame
// under reduced motion. Returns a stop function.
export const footerArt = (canvas: HTMLCanvasElement, { dark }: Options) => {
  const ctx = canvas.getContext("2d");
  const buffer = document.createElement("canvas");
  const bctx = buffer.getContext("2d");

  if (!ctx || !bctx) {
    throw new Error("2D canvas context unavailable");
  }

  blueNoise ??= buildBlueNoise();
  const threshold = blueNoise;

  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let still = motion.matches;
  let visible = true;
  let frame = 0;
  let last = -Infinity;
  let cell = 2;
  let grid: Grid | undefined;
  let image: ImageData | undefined;

  const resize = () => {
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // Fine dots, like stipple (finer on phones, to keep the towns' detail).
    cell = w < 640 ? 1.5 : 2;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    grid = compose(Math.ceil(w / cell), Math.ceil(h / cell), dark);
    buffer.width = grid.cols;
    buffer.height = grid.rows;
    image = bctx.createImageData(grid.cols, grid.rows);
  };

  const draw = (now: number) => {
    if (!grid || !image) {
      return;
    }

    const t = still ? 20 : now / 1000;
    const px = new Uint32Array(image.data.buffer);

    dither(grid, px, threshold, t, dark);
    drawBoat(grid, px, t);

    // Colour the 1-bit mask with the ink, then scale it up with hard edges.
    bctx.putImageData(image, 0, 0);
    bctx.globalCompositeOperation = "source-in";
    bctx.fillStyle = getComputedStyle(canvas).color;
    bctx.fillRect(0, 0, grid.cols, grid.rows);
    bctx.globalCompositeOperation = "source-over";

    const scale = canvas.width / canvas.clientWidth;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      buffer,
      0,
      0,
      grid.cols * cell * scale,
      grid.rows * cell * scale
    );
  };

  // About 12 frames a second is plenty for a slow drift, and cheap.
  const loop = (now: number) => {
    if (now - last > 80) {
      last = now;
      draw(now);
    }

    if (!still && visible) {
      frame = requestAnimationFrame(loop);
    }
  };

  const restart = () => {
    cancelAnimationFrame(frame);
    last = -Infinity;
    frame = requestAnimationFrame(loop);
  };

  const sizer = new ResizeObserver(() => {
    resize();
    restart();
  });

  const onMotionChange = () => {
    still = motion.matches;
    restart();
  };

  const visibility = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;

    if (visible) {
      restart();
    }
  });

  sizer.observe(canvas);
  visibility.observe(canvas);
  motion.addEventListener("change", onMotionChange);

  return () => {
    cancelAnimationFrame(frame);
    sizer.disconnect();
    visibility.disconnect();
    motion.removeEventListener("change", onMotionChange);
  };
};
