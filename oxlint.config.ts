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
  // @shadcn/lint as warnings: every rule on the website, a subset on mobile.
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
    {
      // Only the rules that fit React Native and Uniwind: the linter can't see
      // Uniwind's per-theme tokens (no-unknown-classes), RN needs inline styles
      // for animation and measured sizes (no-inline-styles), and our primitives
      // take layout and colour classes by design (no-restyle).
      files: ["mobile/**"],
      rules: {
        "shadcn/no-arbitrary-values": "warn",
        "shadcn/no-raw-colors": "warn",
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
