import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("src", import.meta.url)),
    },
  },
  test: {
    alias: {
      "expo-sqlite": fileURLToPath(
        new URL("test/support/sqlite.ts", import.meta.url)
      ),
    },
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
