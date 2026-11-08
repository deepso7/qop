import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildDesktopVectors,
  VECTORS_DIR,
} from "../scripts/desktop-vectors.ts";

describe("desktop golden vectors", () => {
  it("match the committed files (regenerate: pnpm --filter @qop/cli vectors:desktop)", async () => {
    for (const [name, contents] of await buildDesktopVectors()) {
      expect(contents, name).toBe(
        readFileSync(new URL(name, VECTORS_DIR), "utf-8")
      );
    }
  });
});
