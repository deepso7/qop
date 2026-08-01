import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    ".agents/skills/**",
    ".claude/**",
    "mobile/src/uniwind-types.d.ts",
  ],
});
