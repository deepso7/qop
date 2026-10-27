// Geometry for the welcome art: two qop "o" marks joined by a stepped wire.
// Everything lives on a fine grid of `cell` points; a mark module is three
// cells, so the marks, their dithered halos and the wire all snap together.

export interface Cell {
  x: number;
  y: number;
}

// The app icon's "o": four bars with notched corners on a 6x6 module grid.
const O_MARK = [".####.", "######", "##..##", "##..##", "######", ".####."];

const MODULE = 3;

// Halo reach, in cells beyond the mark's edge.
const HALO = 6;

// Deterministic per-cell noise in 0..1: an organic scatter, unlike an
// ordered matrix, which lines up into stripes along a straight edge.
const hash = (x: number, y: number) => {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43_758.5453;

  return v - Math.floor(v);
};

// Mark-relative cells (0..17) that the "o" fills.
const markCells = O_MARK.flatMap((row, my) =>
  [...row].flatMap((c, mx) =>
    c === "#"
      ? Array.from({ length: MODULE * MODULE }, (_, i) => ({
          x: mx * MODULE + (i % MODULE),
          y: my * MODULE + Math.floor(i / MODULE),
        }))
      : []
  )
);

const SIZE = O_MARK.length * MODULE;
const filled = new Set(markCells.map(({ x, y }) => y * SIZE + x));

const isMark = (x: number, y: number) =>
  x >= 0 && y >= 0 && x < SIZE && y < SIZE && filled.has(y * SIZE + x);

// The hole stays empty so the mark always reads as a ring.
const HOLE_START = 2 * MODULE;
const HOLE_END = 4 * MODULE;

const inHole = (x: number, y: number) =>
  x >= HOLE_START && x < HOLE_END && y >= HOLE_START && y < HOLE_END;

// Distance in cells from (x, y) to the nearest filled mark cell.
const distanceToMark = (x: number, y: number) => {
  let best = Infinity;

  for (const cell of markCells) {
    best = Math.min(best, Math.hypot(cell.x - x, cell.y - y));
  }

  return best;
};

// Halo cells around a mark: a dithered scatter that thins out with
// distance, so the solid mark breaks into loose pixels at its edge.
// Grains per cell along each axis: the halo is finer than the mark, so it
// reads as a scatter of grains rather than chunks broken off it.
const GRAIN = 2;

// Halo grains around a mark, in grain units (1/GRAIN of a cell).
const haloCells = () => {
  const grains: Cell[] = [];

  for (let gy = -HALO * GRAIN; gy < (SIZE + HALO) * GRAIN; gy += 1) {
    for (let gx = -HALO * GRAIN; gx < (SIZE + HALO) * GRAIN; gx += 1) {
      const x = (gx + 0.5) / GRAIN - 0.5;
      const y = (gy + 0.5) / GRAIN - 0.5;
      const cx = Math.floor(gx / GRAIN);
      const cy = Math.floor(gy / GRAIN);

      if (isMark(cx, cy) || inHole(cx, cy)) {
        continue;
      }

      const d = distanceToMark(x, y);

      if (d > HALO) {
        continue;
      }

      // A clear cell around the mark keeps its silhouette crisp; beyond it
      // the grains thin out like a signal radiating from the peer.
      const density =
        d < 1.5 ? 0 : 0.26 * (1 - (d - 1.5) / (HALO - 1.5)) ** 1.6;

      if (density > hash(gx, gy)) {
        grains.push({ x: gx, y: gy });
      }
    }
  }

  return grains;
};

const halo = haloCells();

// Rasterises a quadratic curve into an ordered staircase of cells, so the
// index is the distance along the wire.
export const staircase = (p0: Cell, c: Cell, p2: Cell) => {
  const path: Cell[] = [];

  for (let i = 0; i <= 1000; i += 1) {
    const u = i / 1000;

    const along = (a: number, b: number, d: number) =>
      Math.round((1 - u) ** 2 * a + 2 * (1 - u) * u * b + u * u * d);

    const x = along(p0.x, c.x, p2.x);
    const y = along(p0.y, c.y, p2.y);
    const last = path.at(-1);

    if (last?.x === x && last.y === y) {
      continue;
    }

    // Drop the inner cell of an L-step so the wire stays one cell thick.
    const prev = path.at(-2);

    if (prev && Math.abs(prev.x - x) <= 1 && Math.abs(prev.y - y) <= 1) {
      path.pop();
    }

    path.push({ x, y });
  }

  return path;
};

// Points along a quadratic curve spaced evenly by distance, so a packet
// interpolating between them glides at a steady speed.
const evenly = (p0: Cell, c: Cell, p2: Cell, count = 96) => {
  const fine = Array.from({ length: 401 }, (_, i) => {
    const u = i / 400;

    return {
      x: (1 - u) ** 2 * p0.x + 2 * (1 - u) * u * c.x + u * u * p2.x,
      y: (1 - u) ** 2 * p0.y + 2 * (1 - u) * u * c.y + u * u * p2.y,
    };
  });

  const lengths = [0];

  for (let i = 1; i < fine.length; i += 1) {
    const a = fine[i - 1] ?? p0;
    const b = fine[i] ?? p0;

    lengths.push((lengths[i - 1] ?? 0) + Math.hypot(b.x - a.x, b.y - a.y));
  }

  const total = lengths.at(-1) ?? 0;
  let j = 0;

  return Array.from({ length: count + 1 }, (_, k) => {
    const target = (total * k) / count;

    while (j < lengths.length - 2 && (lengths[j + 1] ?? 0) < target) {
      j += 1;
    }

    const from = fine[j] ?? p0;
    const to = fine[j + 1] ?? from;
    const span = (lengths[j + 1] ?? 0) - (lengths[j] ?? 0);
    const t = span > 0 ? (target - (lengths[j] ?? 0)) / span : 0;

    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  });
};

// Gentle sine ease in and out: the packet leaves softly and settles into the
// mark, peaking at ~1.6x its average speed (a cubic darts at 3x).
export const easeInOut = (t: number) => {
  "worklet";

  return (1 - Math.cos(Math.PI * t)) / 2;
};

export interface PeersScene {
  // Cell size in points.
  readonly cell: number;
  // Top-left cell of each mark: the sender, then the receiver.
  readonly marks: readonly [Cell, Cell];
  readonly markSize: number;
  // The packet's route: the wire's curve, evenly spaced, in (fractional) cells.
  readonly route: readonly Cell[];
  readonly wire: readonly Cell[];
}

// Lays the two marks on a shallow diagonal inside a w x h point box (first on
// the left margin, second one mark lower on the right margin), low in the
// box, with the wire humping over from one to the other.
export const buildPeers = (
  w: number,
  h: number,
  margin: number
): PeersScene => {
  // A module of ~w/22 points: 18pt marks modules on a 400pt-wide phone.
  const cell = Math.max(4, Math.floor(w / 22 / MODULE));
  const cols = Math.floor(w / cell);
  const rows = Math.floor(h / cell);
  const pad = Math.round(margin / cell);
  // Arc height above the first mark, and the drop to the second.
  const rise = 2 * MODULE;
  const drop = SIZE;
  const height = rise + SIZE + drop;

  // Sits low in the box, near the copy below, with the spare room above.
  const top = Math.max(
    HALO + rise,
    Math.round((rows - height - HALO) * 0.7) + rise
  );

  const a = { x: pad, y: top };
  const b = { x: cols - pad - SIZE, y: top + drop };

  const curve = [
    { x: a.x + SIZE + 2, y: a.y + MODULE },
    { x: Math.round((a.x + b.x + SIZE) / 2) + MODULE, y: a.y - rise * 2 },
    { x: b.x + SIZE / 2, y: b.y - 3 },
  ] as const;

  return {
    cell,
    marks: [a, b],
    markSize: SIZE,
    route: evenly(...curve),
    wire: staircase(...curve),
  };
};

// SVG path of 1x1 cells at `cells`, offset by `origin`, at `cell` points each.
const ORIGIN: Cell = { x: 0, y: 0 };

export const cellsPath = (
  cells: readonly Cell[],
  cell: number,
  origin: Cell = ORIGIN
) =>
  cells
    .map(
      ({ x, y }) =>
        `M${(origin.x + x) * cell} ${(origin.y + y) * cell}h${cell}v${cell}h-${cell}z`
    )
    .join("");

export const markPath = (origin: Cell, cell: number) =>
  cellsPath(markCells, cell, origin);

export const haloPath = (origin: Cell, cell: number) =>
  cellsPath(halo, cell / GRAIN, {
    x: origin.x * GRAIN,
    y: origin.y * GRAIN,
  });

// The wire as dashes: two cells on, one off.
export const wirePath = (wire: readonly Cell[], cell: number) =>
  cellsPath(
    wire.filter((_, i) => i % 3 < 2),
    cell
  );

// The hole of a mark (2x2 modules), for the arrival flash.
export const holeOf = (mark: Cell) => ({
  size: 2 * MODULE,
  x: mark.x + 2 * MODULE,
  y: mark.y + 2 * MODULE,
});

// Seconds per exchange: a send one way, a beat, a reply the other way, a rest.
export const PERIOD = 5;
export const TRAVEL = 1.7;
export const FLASH = 0.22;
const REPLY_AT = 2.6;

// Where the packet is at `t` seconds into the exchange: progress along the
// wire (0 at the first mark, 1 at the second), or -1 while resting; which way
// it travels (1 out, -1 back); and which mark's hole is lit (0 or 1), or -1.
export const exchangeAt = (t: number) => {
  "worklet";

  const s = ((t % PERIOD) + PERIOD) % PERIOD;

  if (s < TRAVEL) {
    return { dir: 1, lit: -1, progress: s / TRAVEL };
  }

  if (s < TRAVEL + FLASH) {
    return { dir: 1, lit: 1, progress: -1 };
  }

  if (s >= REPLY_AT && s < REPLY_AT + TRAVEL) {
    return { dir: -1, lit: -1, progress: 1 - (s - REPLY_AT) / TRAVEL };
  }

  if (s >= REPLY_AT + TRAVEL && s < REPLY_AT + TRAVEL + FLASH) {
    return { dir: -1, lit: 0, progress: -1 };
  }

  return { dir: 1, lit: -1, progress: -1 };
};
