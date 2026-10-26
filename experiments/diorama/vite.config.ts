import { defineConfig } from "vite";
import type { Plugin } from "vite";

// three ships its GLSL as indented, commented template strings, which the JS
// minifier can't touch. This squeezes them: no comment lines, no indentation,
// no blank lines, no spaces inside brackets or around = , ; ? : < > { }.
// Newlines and preprocessor lines stay as they are: three's `#include <x>`
// needs its space, and `#define F (x)` differs from `#define F(x)`.
const squeeze = (line: string) =>
  line.startsWith("#")
    ? line
    : line
        .replaceAll(/\s*(?<op>[=,;?:<>{}])\s*/gu, "$<op>")
        .replaceAll(/\(\s+/gu, "(")
        .replaceAll(/\s+\)/gu, ")");

// Shaders for materials and features this page never uses (we only draw
// MeshBasic, MeshLambert and the shadow depth pass). Blanked at build time.
const unused = new Set([
  "meshphysical",
  "meshphong",
  "meshtoon",
  "meshmatcap",
  "meshnormal",
  "linedashed",
  "points",
  "sprite",
  "background",
  "backgroundCube",
  "cube",
  "equirect",
  "distance",
  "shadow",
  "vsm",
  "lights_physical_pars_fragment",
  "lights_physical_fragment",
  "envmap_physical_pars_fragment",
  "transmission_pars_fragment",
  "transmission_fragment",
  "iridescence_fragment",
  "tonemapping_pars_fragment",
  "lights_phong_pars_fragment",
  "lights_phong_fragment",
  "lights_toon_pars_fragment",
  "lights_toon_fragment",
]);

const slimThree = (): Plugin => ({
  name: "slim-three",
  apply: "build",
  transform(code, id) {
    const shader =
      /node_modules\/three\/src\/renderers\/shaders\/.*\/(?<name>\w+)\.glsl\.js$/u.exec(
        id
      );

    if (!shader) {
      return;
    }

    if (unused.has(shader.groups?.name ?? "")) {
      return { code: code.replaceAll(/`[^`]*`/gu, "``"), map: null };
    }

    const lines = code
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("//"));

    return { code: lines.map(squeeze).join("\n"), map: null };
  },
});

export default defineConfig({
  plugins: [slimThree()],
  // three's per-file sources tree-shake far better than its prebuilt bundle.
  resolve: { alias: [{ find: /^three$/u, replacement: "three/src/Three.js" }] },
});
