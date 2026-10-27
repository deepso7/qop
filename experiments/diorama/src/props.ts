import { CircleGeometry, Group, Mesh } from "three";

import { hash, zone } from "./island";
import type { Colour } from "./palette";
import { cctv, hoard, island, tower, tree } from "./play";
import { BLOB_LAYER } from "./post";
import { voxels } from "./voxel";
import type { Voxel } from "./voxel";

/**
 * Turns an ASCII sketch into a flat glyph facing +z, one voxel per character.
 * Rows run top to bottom; characters missing from `key` are empty.
 */
const glyph = (
  art: string,
  key: Record<string, Colour>,
  depth = 1
): Voxel[] => {
  const rows = art
    .trim()
    .split("\n")
    .map((row) => row.trim());

  return rows.flatMap((row, r) =>
    [...row].flatMap((ch, x) => {
      const c = key[ch];

      if (!c) {
        return [];
      }

      return Array.from({ length: depth }, (_, z): Voxel => [
        x - row.length / 2,
        rows.length - 1 - r,
        z,
        c,
      ]);
    })
  );
};

/**
 * The surveillance tower: a server stack with a big eye on the front and a
 * blinking antenna. Returns the pupil and the light so the loop can drive them.
 */
export const makeTower = () => {
  const [cx, cz] = tower.cell;
  const list: Voxel[] = [];

  for (let y = 0; y < tower.height; y++) {
    for (let x = cx; x < cx + 3; x++) {
      for (let z = cz; z < cz + 3; z++) {
        const rack = y % 3 === 2 || y === tower.height - 1;
        list.push([x, y, z, rack ? "metalDark" : "metal"]);
      }
    }
  }

  // The eyeball bulges out of the front, under a heavy brow. It glows so it
  // stays crisp white instead of dithering with the shading.
  const eyeball: Voxel[] = [];

  for (let x = cx; x < cx + 3; x++) {
    for (let y = 6; y <= 8; y++) {
      eyeball.push([x, y, cz + 3, "paper"]);
    }
  }

  for (let x = cx - 1; x < cx + 4; x++) {
    list.push([x, 9, cz + 3, "metalDark"]);
  }

  // Antenna.
  list.push(
    [cx + 1, tower.height, cz + 1, "metalDark"],
    [cx + 1, tower.height + 1, cz + 1, "metal"]
  );

  const body = voxels(list);

  // Rack LEDs down the right face.
  const leds = voxels(
    [1, 4, 7].flatMap((y): Voxel[] => [
      [(cx + 3) * 2, y * 2, cz * 2 + 1, "foam"],
      [(cx + 3) * 2, y * 2, cz * 2 + 4, "foam"],
    ]),
    { kind: "glow", size: 0.5 }
  );

  leds.position.x = -0.4;

  // Red iris with a dark pupil, poking out of the eyeball.
  const pupil = new Group();
  const iris = voxels([[0, 0, 0, "alarm"]], { kind: "glow" });
  iris.scale.z = 0.3;
  const dot = voxels([[0.5, 0.5, 0, "ink"]], { size: 0.5, shadows: false });
  dot.scale.z = 0.5;
  dot.position.z = 0.15;
  pupil.add(iris, dot);

  const light = voxels([[cx + 1, tower.height + 2, cz + 1, "alarm"]], {
    kind: "glow",
  });

  const group = new Group();
  group.add(body, voxels(eyeball, { kind: "glow" }), leds, pupil, light);

  return { group, pupil, light };
};

/**
 * A street camera on a pole. The head pivots around the pole top and looks
 * along +z by default; the loop turns it.
 */
export const makeCctv = () => {
  const [x, z] = cctv.cell;

  const pole = voxels(
    Array.from({ length: cctv.height * 2 }, (_, y): Voxel => [
      x * 2 + 0.5,
      y,
      z * 2 + 0.5,
      "metalDark",
    ]),
    { size: 0.5 }
  );

  // A 1×1×2 box with a dark lens on the front and a red recording light.
  const box: Voxel[] = [];

  for (const bx of [-1, 0]) {
    for (const by of [0, 1]) {
      for (let bz = -2; bz <= 2; bz++) {
        box.push([bx, by, bz, bz === 2 ? "ink" : "paper"]);
      }
    }
  }

  const head = new Group();
  const rec = voxels([[-1, 2, -2, "alarm"]], { size: 0.5, kind: "glow" });
  head.add(voxels(box, { size: 0.5 }), rec);
  head.position.set(x + 0.5, cctv.height, z + 0.5);
  const group = new Group();
  group.add(pole, head);

  return { group, head, rec };
};

/** A blossoming tree for the qop side. */
export const makeTree = () => {
  const [cx, cz] = tree.cell;
  const list: Voxel[] = [];

  for (let y = 0; y < 3; y++) {
    list.push([cx, y, cz, "soilDark"]);
  }

  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      for (let y = 3; y <= 5; y++) {
        const corner = Math.abs(x) + Math.abs(z) === 2;

        if (corner && (y === 3 || y === 5)) {
          continue;
        }

        const bloom = hash(x + 9 * y, z + 3) > 0.72;
        list.push([cx + x, y, cz + z, bloom ? "blossom" : "leaf"]);
      }
    }
  }

  list.push([cx, 6, cz, "leaf"]);

  return voxels(list);
};

/** Little flowers scattered over the grass. */
export const makeFlowers = () => {
  const list: Voxel[] = [];

  for (let x = 0; x < island.size; x++) {
    for (let z = 0; z < island.size; z++) {
      if (zone(x, z) !== "grass" || hash(x * 5, z * 11) < 0.86) {
        continue;
      }

      const c: Colour = hash(z, x) > 0.5 ? "flower" : "blossom";
      list.push([x * 2 + 1, 0, z * 2 + (hash(x, z * 7) > 0.5 ? 1 : 0), c]);
    }
  }

  return voxels(list, { size: 0.5, shadows: false });
};

/** Copies the tower has always kept. The loop stacks new ones on top and pulls them in again. */
export const makeHoard = () => {
  const [x, , z] = hoard.base;

  const old = voxels([
    [x, 0, z, "oldBubble"],
    [x + 1, 0, z, "oldBubble"],
    [x, 1, z, "oldBubble"],
  ]);

  return old;
};

/** A single logged copy: a data cube that drops onto the hoard. */
export const makeCopy = () => voxels([[0, 0, 0, "oldBubble"]]);

/** A chat bubble with dots on its face: blue for the usual apps, white and orange for qop. */
export const makeBubble = (body: Colour, dots: Colour) =>
  voxels(
    glyph(
      `
      BBBBB
      BdBdB
      BBBBB
      .B...
      `,
      { B: body, d: dots },
      2
    ),
    { size: 0.5, shadows: false }
  );

/** An ad that pops up over someone after the tower reads their message. */
export const makeAd = () =>
  voxels(
    glyph(
      `
      aaaaaa
      apppfa
      apppfa
      aaaaaa
      ..mm..
      ..mm..
      `,
      { a: "ad", p: "paper", f: "flower", m: "metalDark" }
    ),
    { size: 0.5, shadows: false }
  );

/** The tower's "?" when it sees a qop message it can't read. */
export const makeQuestion = () =>
  voxels(
    glyph(
      `
      .yyy.
      y...y
      ...y.
      ..y..
      .....
      ..y..
      `,
      { y: "flower" }
    ),
    { size: 0.5, shadows: false }
  );

/** A heart over a qop receiver. */
export const makeHeart = () =>
  voxels(
    glyph(
      `
      .h.h.
      hhhhh
      .hhh.
      ..h..
      `,
      { h: "alarm" }
    ),
    { size: 0.5, shadows: false }
  );

/** Soft round shadow decal for things in the air; only the light pass draws it. */
export const makeBlob = (radius: number) => {
  const blob = new Mesh(new CircleGeometry(radius, 16));
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.02;
  blob.userData.kind = "blob";
  blob.layers.set(BLOB_LAYER);

  return blob;
};
