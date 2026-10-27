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
  overrides: [
    {
      // The design system itself: primitives style their own internals
      // (the rule's documented setup).
      files: ["mobile/src/components/ui/**"],
      rules: { "shadcn/no-restyle": "off" },
    },
    {
      // Standalone Three.js experiments: Three classes are not Effect services,
      // and voxel code leans on counters and bit math.
      files: ["experiments/**"],
      rules: {
        "anti-slop-effect/no-service-constructor-imports": "off",
        "no-bitwise": "off",
        "no-plusplus": "off",
      },
    },
  ],
  rules: {
    "anti-slop-effect/no-service-constructor-imports": "error",
    // Tailwind design-system rules, enforced everywhere.
    "shadcn/no-arbitrary-values": "error",
    // Reanimated computes these on the UI thread; name them `animatedStyle`.
    "shadcn/no-inline-styles": [
      "error",
      { allowDynamicIdentifiers: ["animatedStyle"] },
    ],
    "shadcn/no-raw-colors": "error",
    // Layout is the caller's; appearance comes from a component's variants.
    "shadcn/no-restyle": ["error", { allow: ["layout"] }],
    "shadcn/no-unknown-classes": "error",
    "shadcn/require-static-classes": "error",
    "func-names": "off",
    "max-classes-per-file": "off",
    "promise/prefer-await-to-callbacks": "off",
  },
});
