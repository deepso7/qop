# qop diorama

A 10 second looping isometric pixel-art diorama. Left of the stream, two people chat through the usual apps: every message goes up to the tower, the eye reads it, a copy lands on the data pile and an ad pops up. Right of the stream, two people chat on qop: messages go straight from phone to phone, and the tower can only squint.

Vite + TypeScript + Three.js, rendered at 192×192, Bayer-dithered and upscaled with nearest neighbour.

```sh
pnpm install
pnpm dev                 # live, quantised to the same 30 fps frames as a recording
                         # ?t=4 holds one moment
pnpm shots               # shots/t0.png … t8.png
pnpm record              # frames/0000.png … 0299.png, then ffmpeg (see scripts/record.ts)
pnpm build               # dist/, ~455 KB JS
```

| file | what |
| --- | --- |
| `palette.ts` | the 27 colours; every voxel uses one |
| `island.ts` | floating slab, plaza tiles, grass stripes, stream, waterfall |
| `props.ts` | tower and eye, street camera, tree, data pile, bubbles, ads, glyphs |
| `people.ts` | `makePerson(kit, look)`, walk cycle, phone poses |
| `play.ts` | positions and keyframe tables for the whole story |
| `post.ts` | low-res targets, light levels, Bayer dither, outline |
| `loop.ts` | scene setup and `frame(t)` |
| `main.ts` | renderer, live / `?t=` / `?record=1` modes |
