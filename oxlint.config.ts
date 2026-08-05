import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";

export default defineConfig({
  extends: [core, react, tanstack],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    ".agents/skills/**",
    ".claude/**",
    "mobile/scripts/**",
    "mobile/src/uniwind-types.d.ts",
  ],
  rules: {
    "func-names": "off",
    "max-classes-per-file": "off",
    "promise/prefer-await-to-callbacks": "off",
  },
});
