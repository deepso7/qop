import { Group } from "three";

import type { Colour } from "./palette";
import { voxels } from "./voxel";
import type { Voxel } from "./voxel";

/** Everything that makes one side look like a team. Add a kit, get a new crowd. */
export interface Kit {
  shirt: Colour;
  pants: Colour;
  screen: Colour;
}

export const kits = {
  old: { shirt: "oldShirt", pants: "oldPants", screen: "paper" },
  qop: { shirt: "qop", pants: "qopPants", screen: "paper" },
} as const satisfies Record<string, Kit>;

export interface Look {
  skin: Colour;
  hair: Colour;
}

export interface Pose {
  /** Walk cycle phase in steps (any real); null when standing. */
  walk: number | null;
  /** Thumbs going on the phone. */
  typing: boolean;
  /** Looking up from the phone. */
  startled: boolean;
}

// Body plan, facing +z, feet at y=0, x centred: two legs, a torso, two arms, a
// 2x2x2 head. Six voxels tall.
const leg = (pants: Colour): Voxel[] => [
  [0, 0, 0, "ink"],
  [0, 1, 0, pants],
];

/**
 * Builds a person. Parts are separate so the loop can swing legs and bob the
 * phone; `pose` snaps them to one of a handful of frames, pixel-art style.
 */
/** Leg offset along the facing for each walk frame. */
const STRIDE = [0.5, 0, -0.5, 0];

export const makePerson = (kit: Kit, look: Look) => {
  const legL = voxels(leg(kit.pants));
  const legR = voxels(leg(kit.pants));
  legL.position.set(-1, 0, -0.5);
  legR.position.set(0, 0, -0.5);

  const torso = voxels([
    [-1, 2, 0, kit.shirt],
    [0, 2, 0, kit.shirt],
    [-1, 3, 0, kit.shirt],
    [0, 3, 0, kit.shirt],
    // Shoulders; the forearms reach forward to the phone.
    [-2, 3, 0, kit.shirt],
    [1, 3, 0, kit.shirt],
  ]);

  torso.position.z = -0.5;

  // Hands and phone, held out in front at chest height.
  const hands = voxels(
    [
      [-2, 4, 1, look.skin],
      [1, 4, 1, look.skin],
    ],
    { size: 0.5 }
  );

  const phoneBody = voxels(
    [
      [-1, 4, 1, "ink"],
      [0, 4, 1, "ink"],
    ],
    { size: 0.5 }
  );

  const screen = voxels(
    [
      [-1, 5, 1, kit.screen],
      [0, 5, 1, kit.screen],
    ],
    { size: 0.5, kind: "glow" }
  );

  const phone = new Group();
  phone.add(hands, phoneBody, screen);

  const headList: Voxel[] = [];

  for (const x of [-1, 0]) {
    for (const z of [-1, 0]) {
      headList.push(
        [x, 4, z, z === 0 ? look.skin : look.hair],
        [x, 5, z, look.hair]
      );
    }
  }

  // Eyes: two dark half-voxels poking out of the face.
  const head = new Group();

  const face = voxels(
    [
      [-2, 9, 1, "ink"],
      [1, 9, 1, "ink"],
    ],
    { size: 0.5, shadows: false }
  );

  face.scale.z = 0.3;
  face.position.z = 0.8;
  head.add(voxels(headList), face);
  head.position.z = -0.5;

  const root = new Group();
  root.add(legL, legR, torso, phone, head);

  const pose = ({ walk, typing, startled }: Pose) => {
    // Four-frame step: split, pass, split, pass.
    const frame = walk === null ? -1 : ((Math.floor(walk * 2) % 4) + 4) % 4;
    const stride = STRIDE[frame] ?? 0;
    legL.position.z = -0.5 + stride;
    legR.position.z = -0.5 - stride;
    legL.position.y = frame === 3 ? 0.5 : 0;
    legR.position.y = frame === 1 ? 0.5 : 0;
    phone.position.y = (typing ? 0.25 : 0) + (startled ? -0.5 : 0);
    // Heads bow over the phone, and snap up when something pops up.
    head.position.z = startled ? -0.5 : -0.25;
  };

  return { root, pose };
};
