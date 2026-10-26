// The whole story as data. Positions are in island cells (0..17, x/z), y up.
// Everything in the scene is a pure function of t in [0, LOOP), so editing a
// number here retimes the loop without touching any animation code.
//
// Left of the stream: two people chat through the usual apps. Every message
// goes up to the tower, the eye reads it, keeps a copy, and an ad follows.
// Right of the stream: two people chat on qop. Messages go straight across.

export const LOOP = 10;
export const FPS = 30;

export type Vec3 = readonly [number, number, number];

/** Facing, in quarter turns: 0 = +z (towards camera, left), 1 = +x (towards camera, right). */
export type Facing = 0 | 1 | 2 | 3;

export const island = { size: 18 } as const;

export const tower = {
  cell: [0, 3] as const,
  height: 10,
  eye: [1.5, 7.5, 6] as const,
};

export const tree = { cell: [8, 1] as const };

/** A street camera on the plaza that swivels to follow whoever is on their phone. */
export const cctv = { cell: [1, 16] as const, height: 5 };

/** Old data the tower already hoards in front of itself; new copies stack on top. */
export const hoard = { base: [0, 0, 6] as const };

export const people = {
  L1: {
    at: [2.5, 0, 14.5],
    facing: 0,
    outfit: "old",
    skin: "skinLight",
    hair: "hairDark",
  },
  L2: {
    at: [7.5, 0, 13.5],
    facing: 1,
    outfit: "old",
    skin: "skinDark",
    hair: "hairDark",
  },
  Q1: {
    at: [11.5, 0, 8.5],
    facing: 0,
    outfit: "qop",
    skin: "skinDark",
    hair: "hairBrown",
  },
  Q2: {
    at: [14.5, 0, 3.5],
    facing: 1,
    outfit: "qop",
    skin: "skinLight",
    hair: "hairBrown",
  },
} as const;

export type Who = keyof typeof people;

/** Everyone, for typed iteration. */
export const everyone = [
  "L1",
  "L2",
  "Q1",
  "Q2",
] as const satisfies readonly Who[];

/** Q2 strolls in at the start and back out at the end, phone in hand. */
export const q2Walk = {
  from: [14.5, 0, 0.5] as const,
  keys: [
    [0, 0],
    [1.5, 1],
    [8.6, 1],
    [9.9, 0],
  ] as const,
};

/** Messages through the usual apps: sender → tower eye (logged) → receiver. */
export const oldMessages = [
  { from: "L1", to: "L2", send: 0.8, read: 1.8, leave: 2.3, arrive: 3.2 },
  { from: "L2", to: "L1", send: 5, read: 6, leave: 6.5, arrive: 7.4 },
] as const satisfies readonly {
  from: Who;
  to: Who;
  send: number;
  read: number;
  leave: number;
  arrive: number;
}[];

/** qop messages: straight from phone to phone. */
export const qopMessages = [
  { from: "Q1", to: "Q2", send: 3.4, arrive: 4.2 },
  { from: "Q2", to: "Q1", send: 4.7, arrive: 5.5 },
  { from: "Q1", to: "Q2", send: 7.6, arrive: 8.3 },
] as const satisfies readonly {
  from: Who;
  to: Who;
  send: number;
  arrive: number;
}[];

/** How long an ad hangs over the receiver of an old-app message. */
export const AD_TIME = 1.5;

/** How long the tower squints at a qop message it can't read. */
export const PUZZLED_TIME = 1.1;

/** When the logged copies get pulled into the tower so the loop can restart. */
export const ABSORB = [9, 9.8] as const;

// ---------------------------------------------------------------- helpers

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 0→1 over [a, b]. */
export const progress = (t: number, a: number, b: number) =>
  clamp01((t - a) / (b - a));

export const smooth = (x: number) => x * x * (3 - 2 * x);

export const lerp3 = (a: Vec3, b: Vec3, k: number): Vec3 => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
];

/** A parabolic hop from a to b peaking `height` above the straight line. */
export const arc = (a: Vec3, b: Vec3, k: number, height: number): Vec3 => {
  const p = lerp3(a, b, k);

  return [p[0], p[1] + 4 * height * k * (1 - k), p[2]];
};

/** Samples a [time, value] key table linearly, holding the ends. */
export const sample = (
  keys: readonly (readonly [number, number])[],
  t: number
) => {
  let [[, value]] = keys;

  for (const [i, [t1, v1]] of keys.entries()) {
    if (t1 > t) {
      if (i === 0) {
        return value;
      }

      const [t0, v0] = keys[i - 1];

      return v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
    }

    value = v1;
  }

  return value;
};
