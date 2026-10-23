// Bundles the API for deployment:
// - `dist/main.mjs`, the Node server that `Dockerfile` runs.
// - `.vercel/output`, a prebuilt Vercel deployment (Build Output API v3) that routes every path to one function.
import { mkdir, rm, writeFile } from "node:fs/promises";

import { build } from "esbuild";
import type { BuildOptions } from "esbuild";

const shared = {
  // pg is CommonJS and calls `require`, which ESM output lacks.
  banner: {
    js: 'import{createRequire}from"node:module";const require=createRequire(import.meta.url);',
  },
  bundle: true,
  // pg only loads its optional native driver on demand.
  external: ["pg-native"],
  format: "esm",
  keepNames: true,
  logLevel: "warning",
  minify: true,
  platform: "node",
  sourcemap: true,
  sourcesContent: false,
  target: "node24",
} satisfies BuildOptions;

const vercelOutput = ".vercel/output";
const vercelFunction = `${vercelOutput}/functions/index.func`;

await rm(vercelOutput, { force: true, recursive: true });

await Promise.all([
  build({ ...shared, entryPoints: ["src/main.ts"], outfile: "dist/main.mjs" }),
  build({
    ...shared,
    entryPoints: ["src/vercel.ts"],
    outfile: `${vercelFunction}/index.mjs`,
  }),
]);

await mkdir(vercelFunction, { recursive: true });

await Promise.all([
  writeFile(
    `${vercelOutput}/config.json`,
    JSON.stringify({ routes: [{ dest: "/index", src: "/(.*)" }], version: 3 })
  ),
  writeFile(
    `${vercelFunction}/.vc-config.json`,
    JSON.stringify({
      handler: "index.mjs",
      launcherType: "Nodejs",
      runtime: "nodejs24.x",
      shouldAddHelpers: false,
      shouldAddSourcemapSupport: true,
      supportsResponseStreaming: true,
    })
  ),
]);
