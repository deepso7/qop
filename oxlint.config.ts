import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";

export default defineConfig({
  extends: [core, react, tanstack, antiSlop],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    ".agents/skills/**",
    ".claude/**",
    "contracts/lib/**",
    "mobile/scripts/**",
    "mobile/src/uniwind-types.d.ts",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    // Tailwind design-system rules (https://github.com/shadcn-ui/lint).
    "@shadcn/lint",
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts",
    },
  ],
  // Trial of @shadcn/lint on the website: warnings only, to see what it finds.
  // The mobile app gets its own rollout.
  overrides: [
    {
      files: ["web/**"],
      rules: {
        "shadcn/no-arbitrary-values": "warn",
        "shadcn/no-inline-styles": "warn",
        "shadcn/no-raw-colors": "warn",
        "shadcn/no-restyle": "warn",
        "shadcn/no-unknown-classes": "warn",
        "shadcn/require-static-classes": "warn",
      },
    },
  ],
  rules: {
    "anti-slop-effect/no-service-constructor-imports": "error",
    "func-names": "off",
    "max-classes-per-file": "off",
    "promise/prefer-await-to-callbacks": "off",
  },
});
