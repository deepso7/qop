import { Group } from "three";
import type { InstancedMesh } from "three";

import type { Colour } from "./palette";
import { island } from "./play";
import { recolour, voxels } from "./voxel";
import type { Voxel } from "./voxel";

const N = island.size;

/** Stable per-cell noise so the island looks hand-chipped but never changes. */
export const hash = (x: number, z: number) => {
  let h = Math.imul(x, 374_761_393) ^ Math.imul(z, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);

  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
};

/** Which side of the stream a cell is on. The stream runs corner to corner. */
export const zone = (x: number, z: number) => {
  const d = x - z;

  if (d < 0) {
    return "plaza";
  }

  return d > 1 ? "grass" : "stream";
};

const topColour = (x: number, z: number): Colour => {
  const where = zone(x, z);

  if (where === "plaza") {
    return ((x >> 1) + (z >> 1)) % 2 ? "tileDark" : "tileLight";
  }

  if (where === "grass") {
    return ((x + z) >> 1) % 2 ? "grassDark" : "grassLight";
  }

  return "water";
};

/** How deep the floating chunk hangs under a cell: deeper in the middle, ragged at the rim. */
const depth = (x: number, z: number) => {
  const inset = Math.min(x, z, N - 1 - x, N - 1 - z);

  return Math.min(8, 2 + Math.floor(inset * 0.9 + hash(x, z) * 1.6));
};

const underColour = (x: number, y: number, z: number): Colour => {
  if (y === -2) {
    return "soil";
  }

  if (y >= -4) {
    return hash(x * 7, z + y) > 0.75 ? "soilDark" : "soil";
  }

  return hash(x, z * 3 + y) > 0.8 ? "soilDark" : "rock";
};

// The stream leaves the island at the front corner and falls off the edge.
const FALL = 5;
const fallCells: Voxel[] = [];

for (let y = 0; y < FALL; y++) {
  fallCells.push([N - 1, -1 - y, N, "water"], [N, -1 - y, N - 2, "water"]);
}

// Foam bands scroll down the waterfall; 6 steps a second divides the loop evenly.
const tickFall = (fall: InstancedMesh, t: number) => {
  const step = Math.floor(t * 6);

  for (const [i, [, y]] of fallCells.entries()) {
    const foam = (step - y + (i % 2)) % 3 === 0;
    recolour(fall, i, foam ? "foam" : "water");
  }
};

/**
 * The floating chunk: tiled plaza left of the stream, mown grass right of it,
 * soil and rock tapering underneath. Returns the island and a per-frame tick
 * for the waterfall.
 */
export const makeIsland = () => {
  const ground: Voxel[] = [];
  const water: Voxel[] = [];

  for (let x = 0; x < N; x++) {
    for (let z = 0; z < N; z++) {
      if (zone(x, z) === "stream") {
        water.push([x, -1, z, "water"]);
      } else {
        ground.push([x, -1, z, topColour(x, z)]);
      }

      for (let y = -2; y >= -depth(x, z); y--) {
        ground.push([x, y, z, underColour(x, y, z)]);
      }
    }
  }

  const group = new Group();
  group.add(voxels(ground));

  // Water sits a little lower than the banks so the stream reads as a channel.
  const stream = voxels(water);
  stream.position.y = -0.3;
  group.add(stream);

  const fall = voxels(fallCells, { shadows: false });
  fall.position.y = -0.3;
  group.add(fall);

  return { group, tick: (t: number) => tickFall(fall, t) };
};
