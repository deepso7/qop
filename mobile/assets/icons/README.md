# App icon variants

Run `pnpm --filter mobile icons:generate` from the repository root after changing the icon geometry or palette.

| Variant | Light / dark treatment | Build identity |
| --- | --- | --- |
| Production | Orange/black; black/orange | `sh.qop` |
| Preview | Cream/orange with one pixel; black/orange with one pixel | `sh.qop.preview` |
| Development | Cream/orange with two pixels; black/orange with two pixels | `sh.qop.dev` |

Each variant contains:

- `ios.png`: light-appearance fallback used by the top-level Expo icon setting.
- `ios-light.png`: opaque, full-bleed 1024×1024 iOS light icon.
- `ios-dark.png`: opaque, full-bleed 1024×1024 iOS dark icon.
- `android-foreground.png`: transparent 1024×1024 adaptive foreground.
- `android-monochrome.png`: single-color Android themed-icon layer.
- `android-legacy.png`: combined fallback with stepped, grid-aligned corners for pre-adaptive Android launchers.
- `favicon.png`: 64×64 web favicon rendered directly on the same logical grid.

The Android foreground artwork stays within the centered 66/108 adaptive-icon safe zone. Do not add corner masks or shadows to the iOS source image; iOS applies its own mask.

The mark is defined on a 64×64 logical grid. Every source edge lands on the 16px grid in the 1024×1024 masters and on a whole pixel in the 64×64 favicon; the generator rejects fractional rectangle coordinates.
