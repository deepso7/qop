import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge our extra vocabulary so `cn` merges it correctly:
// - the custom size tokens in global.css, so `text-headline` replaces
//   `text-base` instead of being mistaken for a colour;
// - uniwind's `border-continuous` / `border-circular` (borderCurve), which
//   would otherwise read as a border colour and drop `border-border`.
const twMerge = extendTailwindMerge<"border-curve">({
  extend: {
    classGroups: {
      "border-curve": ["border-continuous", "border-circular"],
    },
    theme: {
      radius: ["bubble", "icon", "panel", "tile"],
      text: ["headline", "subhead"],
    },
  },
});

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
