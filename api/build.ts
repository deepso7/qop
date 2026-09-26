// Bundles the API and its dependencies into a single `dist/main.mjs` for deployment.
import { build } from "esbuild";

await build({
  // pg is CommonJS and calls `require`, which ESM output lacks.
  banner: {
    js: 'import{createRequire}from"node:module";const require=createRequire(import.meta.url);',
  },
  bundle: true,
  entryPoints: ["src/main.ts"],
  // pg only loads its optional native driver on demand.
  external: ["pg-native"],
  format: "esm",
  keepNames: true,
  logLevel: "warning",
  minify: true,
  outfile: "dist/main.mjs",
  platform: "node",
  sourcemap: true,
  sourcesContent: false,
  target: "node24",
});
