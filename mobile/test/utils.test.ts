import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";

describe("cn", () => {
  it("keeps a border colour beside uniwind's border-curve classes", () => {
    expect(cn("border-border border-continuous border")).toContain(
      "border-border"
    );
  });

  it("merges the custom size tokens as sizes", () => {
    expect(cn("rounded-xl", "rounded-icon")).toBe("rounded-icon");
    expect(cn("text-foreground text-base", "text-headline")).toBe(
      "text-foreground text-headline"
    );
  });
});
