import { describe, expect, it } from "vitest";

import {
  buildPeers,
  exchangeAt,
  FLASH,
  haloPath,
  markPath,
  TRAVEL,
} from "@/components/pixel/peers-field";

// Cells (of `cell` points) touched by a cellsPath string, as "x,y" keys.
// Finer grains map to the cell they sit in.
const cellsOf = (path: string, cell: number) =>
  new Set(
    [...path.matchAll(/M(?<x>-?[\d.]+) (?<y>-?[\d.]+)/gu)].map(
      ({ groups }) =>
        `${Math.floor(Number(groups?.x) / cell)},${Math.floor(Number(groups?.y) / cell)}`
    )
  );

describe("peers art", () => {
  const scene = buildPeers(412, 520, 24);

  it("draws the wire as a contiguous, one-cell staircase", () => {
    for (const [i, cell] of scene.wire.entries()) {
      const prev = scene.wire[i - 1];

      if (prev) {
        expect(Math.abs(cell.x - prev.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(cell.y - prev.y)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("keeps the halo off the mark and its hole, and the marks inside the margins", () => {
    const [first] = scene.marks;
    const mark = cellsOf(markPath(first, scene.cell), scene.cell);
    const halo = cellsOf(haloPath(first, scene.cell), scene.cell);

    expect(halo.size).toBeGreaterThan(0);
    expect([...halo].filter((cell) => mark.has(cell))).toEqual([]);

    // The hole (modules 2..3 of the 6x6 mark) stays empty.
    const hole = Array.from({ length: 36 }, (_, i) => {
      const x = first.x + 6 + (i % 6);
      const y = first.y + 6 + Math.floor(i / 6);

      return `${x},${y}`;
    });

    expect(hole.filter((cell) => halo.has(cell) || mark.has(cell))).toEqual([]);

    for (const { x } of scene.marks) {
      expect(x * scene.cell).toBeGreaterThanOrEqual(24 - scene.cell);
      expect((x + scene.markSize) * scene.cell).toBeLessThanOrEqual(
        412 - 24 + scene.cell
      );
    }
  });

  it("spaces the packet route evenly from one end of the wire to the other", () => {
    const steps = scene.route.slice(1).map((point, i) => {
      const prev = scene.route[i] ?? point;

      return Math.hypot(point.x - prev.x, point.y - prev.y);
    });

    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(0.05);

    for (const [point, cell] of [
      [scene.route.at(0), scene.wire.at(0)],
      [scene.route.at(-1), scene.wire.at(-1)],
    ] as const) {
      expect(Math.round(point?.x ?? -1)).toBe(cell?.x);
      expect(Math.round(point?.y ?? -1)).toBe(cell?.y);
    }
  });

  it("sends, lights the receiver, then replies and lights the sender", () => {
    expect(exchangeAt(TRAVEL / 2)).toMatchObject({ dir: 1, lit: -1 });
    expect(exchangeAt(TRAVEL + FLASH / 2)).toMatchObject({ lit: 1 });
    expect(exchangeAt(2.6 + TRAVEL / 2)).toMatchObject({ dir: -1, lit: -1 });
    expect(exchangeAt(2.6 + TRAVEL + FLASH / 2)).toMatchObject({ lit: 0 });
  });
});
