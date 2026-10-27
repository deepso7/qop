// Writes the website's copy of the loop from frames recorded at native size:
//
//   pnpm web   (node scripts/record.ts --scale 1 && node scripts/web.ts)
//
//   web/public/diorama.webp   lossless animated WebP, all 300 frames, loops forever
//   web/public/diorama.png    the t=4 still, for reduced motion
//
// Lossless keeps the backdrop exactly the site's foam, so it sits seamlessly on
// a bg-foam tile; video's YUV decode shifts it a shade per browser.

import { copyFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

// src/play.ts FPS; scripts run in plain Node, so constants are copied (as in record.ts).
const FPS = 30;

const root = fileURLToPath(new URL("..", import.meta.url));
const frames = path.join(root, "frames");
const out = path.join(root, "../../web/public");

const names = await readdir(frames);

const files = names
  .filter((f) => f.endsWith(".png"))
  .toSorted()
  .map((f) => path.join(frames, f));

const meta = await sharp(files[0]).metadata();

if (meta.width !== 192) {
  throw new Error(`frames are ${meta.width}px wide; record with --scale 1`);
}

// WebP delays are whole milliseconds: 33, 33, 34 keeps 30 fps without drift.
const delay = files.map((_, i) => (i % 3 === 2 ? 34 : 33));

const webp = await sharp(files, { join: { animated: true } })
  .webp({ lossless: true, effort: 6, loop: 0, delay })
  .toFile(path.join(out, "diorama.webp"));

await copyFile(files[4 * FPS], path.join(out, "diorama.png"));

console.log(
  `wrote diorama.webp (${Math.round(webp.size / 1024)} KB) and diorama.png to ${out}`
);
