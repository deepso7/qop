import { ColorManagement } from "three";

// Palette hexes are used as-is, with no sRGB/linear conversion anywhere, so the
// pixels on screen are exactly palette × light level.
ColorManagement.enabled = false;

// The only colours in the diorama. Every voxel picks one of these by name; the
// post pass multiplies them by a few dithered light levels and nothing else.
export const palette = {
  // Outline, phones, pupils
  ink: 0x1c_1d_26,
  // Eye white, sign faces
  paper: 0xf3_ed_e2,

  grassLight: 0x86_c2_5a,
  grassDark: 0x6a_a8_4a,
  leaf: 0x3d_8a_4c,
  blossom: 0xf2_a3_bd,
  flower: 0xf5_c8_4a,

  soil: 0x8f_5d_3d,
  soilDark: 0x5f_3d_2b,
  rock: 0x6c_68_73,

  tileLight: 0xbd_ba_b4,
  tileDark: 0xa1_9e_98,
  metal: 0x7a_82_96,
  metalDark: 0x4d_54_68,
  // Surveillance eye, antenna light
  alarm: 0xe8_38_3d,

  water: 0x4a_a0_dc,
  foam: 0x9f_d8_f2,

  skinLight: 0xf0_c4_9c,
  skinDark: 0x95_60_3f,
  hairDark: 0x2e_23_28,
  hairBrown: 0x70_43_2a,

  // The usual apps: corporate blue

  oldShirt: 0x3e_5e_a6,
  oldPants: 0x2c_32_47,
  oldBubble: 0x5c_95_f2,

  // qop brand orange

  qop: 0xd2_78_4a,
  qopPants: 0x4b_3a_34,

  ad: 0xff_4f_a0,
} as const;

export type Colour = keyof typeof palette;
