import { LinearSRGBColorSpace, PCFSoftShadowMap, WebGLRenderer } from "three";

import { createDiorama } from "./loop";
import { FPS, LOOP } from "./play";
import { createPost, RES } from "./post";

// Modes:
//   default         plays live, but time is quantised to the same 30 fps frames as a recording
//   ?t=4            holds a single moment (seconds into the loop)
//   reduced motion  holds t=4 instead of playing
//   ?record=1       renders nothing on its own; scripts/record.ts calls window.diorama.draw(i)

declare global {
  interface Window {
    diorama?: { frames: number; draw: (i: number) => void };
  }
}

const params = new URLSearchParams(location.search);
const record = params.has("record");
const canvas = document.querySelector<HTMLCanvasElement>("#stage");

if (!canvas) {
  throw new Error("missing #stage canvas");
}

const renderer = new WebGLRenderer({
  canvas,
  antialias: false,
  alpha: true,
  preserveDrawingBuffer: record,
});

renderer.setPixelRatio(1);

renderer.setSize(RES, RES, false);

renderer.outputColorSpace = LinearSRGBColorSpace;

renderer.shadowMap.enabled = true;

renderer.shadowMap.type = PCFSoftShadowMap;

renderer.shadowMap.autoUpdate = false;

const { scene, camera, frame } = createDiorama();
const render = createPost(renderer);
const FRAMES = LOOP * FPS;

const draw = (i: number) => {
  frame((((i % FRAMES) + FRAMES) % FRAMES) / FPS);
  render(scene, camera);
};

// Whole-number upscale in device pixels so every low-res pixel is the same size.
const fit = () => {
  const dpr = devicePixelRatio;

  const scale = Math.max(
    1,
    Math.floor((Math.min(innerWidth, innerHeight) * dpr * 0.92) / RES)
  );

  const side = `${(RES * scale) / dpr}px`;
  canvas.style.width = side;
  canvas.style.height = side;
};

fit();

addEventListener("resize", fit);

if (record) {
  window.diorama = { frames: FRAMES, draw };
  draw(0);
} else if (params.has("t")) {
  draw(Math.round(Number(params.get("t")) * FPS));
} else if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
  // One still that shows both sides at work: an ad on the left, a qop message
  // in flight on the right, and the tower's "?".
  draw(4 * FPS);
} else {
  // Only render when the 30 fps frame index moves on; faster displays would
  // otherwise redraw the same frame several times.
  let last = -1;

  const tick = () => {
    const i = Math.floor((performance.now() / 1000) * FPS);

    if (i !== last) {
      last = i;
      draw(i);
    }

    requestAnimationFrame(tick);
  };

  tick();
}
