import { BoxGeometry, Color, InstancedMesh, Matrix4, Object3D } from "three";

import { palette } from "./palette";
import type { Colour } from "./palette";

/** One voxel: min corner in voxel units, plus its palette colour. */
export type Voxel = readonly [x: number, y: number, z: number, colour: Colour];

/**
 * How the post pass lights a mesh:
 * - solid: lit by the sun, casts and receives shadows
 * - glow: always full brightness (screens, the eye, warning lights)
 * - blob: a soft shadow decal, only drawn into the light buffer
 */
export type Kind = "solid" | "glow" | "blob";

export const isKind = (k: unknown): k is Kind =>
  k === "solid" || k === "glow" || k === "blob";

interface VoxelOptions {
  /** Grid scale; 0.5 gives half-voxels. */
  size?: number;
  kind?: Kind;
  /** Whether a solid mesh casts shadows. */
  shadows?: boolean;
}

const cube = new BoxGeometry(1, 1, 1);
const colours = new Map<Colour, Color>();

const colourOf = (c: Colour) => {
  let colour = colours.get(c);

  if (!colour) {
    colour = new Color(palette[c]);
    colours.set(c, colour);
  }

  return colour;
};

/**
 * Builds a single instanced mesh from a voxel list. `size` scales the grid, so
 * size 0.5 gives half-voxels for small details like faces and glyphs.
 */
export const voxels = (
  list: readonly Voxel[],
  { size = 1, kind = "solid", shadows = true }: VoxelOptions = {}
) => {
  const mesh = new InstancedMesh(cube, undefined, Math.max(list.length, 1));
  const m = new Matrix4();

  for (const [i, [x, y, z, c]] of list.entries()) {
    m.makeScale(size, size, size).setPosition(
      (x + 0.5) * size,
      (y + 0.5) * size,
      (z + 0.5) * size
    );
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, colourOf(c));
  }

  mesh.count = list.length;
  mesh.userData.kind = kind;
  mesh.castShadow = shadows && kind === "solid";
  mesh.receiveShadow = kind === "solid";

  return mesh;
};

/** Recolours one instance; used for per-frame effects like the waterfall. */
export const recolour = (mesh: InstancedMesh, i: number, c: Colour) => {
  mesh.setColorAt(i, colourOf(c));

  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }
};

/** Groups a few meshes under one movable parent. */
export const part = (...children: Object3D[]) => {
  const g = new Object3D();
  g.add(...children);

  return g;
};
