// Exports the loop as PNG frames (or a few stills) through headless Chromium.
//
//   node scripts/record.ts            → frames/0000.png … 0299.png (all 10 s at 30 fps)
//   node scripts/record.ts --shots    → shots/t0.png, t2.png … t8.png
//   node scripts/record.ts --scale 2  → smaller frames (default 4× the 192px render)
//   node scripts/record.ts --dist     → record the production build (run `pnpm build` first)
//
// For the website's loop: `pnpm web` (records at --scale 1, then scripts/web.ts).
//
// Then e.g.:
//   ffmpeg -framerate 30 -i frames/%04d.png -pix_fmt yuv420p -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" diorama.mp4
//   ffmpeg -framerate 30 -i frames/%04d.png -vf "split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=none" diorama.gif

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { chromium } from "playwright";
import { createServer, preview } from "vite";

const RES = 192;

const { values } = parseArgs({
  options: {
    shots: { type: "boolean" },
    dist: { type: "boolean" },
    scale: { type: "string", default: "4" },
  },
});

const scale = Number(values.scale);

const root = fileURLToPath(new URL("..", import.meta.url));

const server = values.dist
  ? await preview({ root, logLevel: "error", preview: { port: 0 } })
  : await createServer({ root, logLevel: "error" }).then((s) => s.listen(0));

const url = server.resolvedUrls?.local[0];

if (!url) {
  throw new Error("vite did not start");
}

// The page picks the largest whole scale that fits 92% of the viewport.
const side = Math.ceil((RES * scale) / 0.92) + 1;

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

const page = await browser.newPage({
  viewport: { width: side, height: side },
  deviceScaleFactor: 1,
});

page.on(
  "console",
  (m) => m.type() === "error" && console.error("page:", m.text())
);

await page.goto(`${url}?record=1`);

await page.waitForFunction(() => window.diorama !== undefined);

const canvas = page.locator("#stage");
const frames = await page.evaluate(() => window.diorama?.frames ?? 0);

// Always inside the experiment, whatever directory the script is run from.
const out = path.join(root, values.shots ? "shots" : "frames");

await rm(out, { recursive: true, force: true });

await mkdir(out);

const indices = values.shots
  ? [0, 2, 4, 6, 8].map((s) => s * 30)
  : Array.from({ length: frames }, (_, i) => i);

// Frames must be drawn and captured one at a time, in order.
for (const i of indices) {
  // oxlint-disable-next-line no-await-in-loop -- sequential by design
  await page.evaluate((n) => window.diorama?.draw(n), i);
  const name = values.shots ? `t${i / 30}` : String(i).padStart(4, "0");
  // oxlint-disable-next-line no-await-in-loop -- sequential by design
  await canvas.screenshot({ path: path.join(out, `${name}.png`) });
}

console.log(`wrote ${indices.length} PNGs to ${out}`);

await browser.close();

await server.close();
