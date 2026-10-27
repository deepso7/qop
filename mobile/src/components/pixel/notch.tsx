import * as React from "react";
import { View } from "react-native";
import type { ViewProps } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

// Path colours from accent-* classes, so notches follow the theme tokens.
const ThemedPath = withUniwind(Path, {
  fill: { fromClassName: "fillClassName", styleProperty: "accentColor" },
  stroke: { fromClassName: "strokeClassName", styleProperty: "accentColor" },
});

// "md" steps each corner twice by 3pt (the web's `notch`), "sm" once (`notch-sm`).
export type NotchCorner = "md" | "sm";

const STEP = 3;

// Outline of a w×h box with stepped corners, inset by `inset` on every side so
// a stroke centred on it stays inside the box.
export const notchPath = (
  width: number,
  height: number,
  corner: NotchCorner,
  inset = 0
) => {
  // Whole-point edges, so a 1pt outline on a fractional-width box stays crisp.
  const l = inset;
  const t = inset;
  const r = Math.floor(width) - inset;
  const b = Math.floor(height) - inset;
  const s = STEP;

  const points =
    corner === "sm"
      ? [
          [l, t + s],
          [l + s, t + s],
          [l + s, t],
          [r - s, t],
          [r - s, t + s],
          [r, t + s],
          [r, b - s],
          [r - s, b - s],
          [r - s, b],
          [l + s, b],
          [l + s, b - s],
          [l, b - s],
        ]
      : [
          [l, t + 2 * s],
          [l + s, t + 2 * s],
          [l + s, t + s],
          [l + 2 * s, t + s],
          [l + 2 * s, t],
          [r - 2 * s, t],
          [r - 2 * s, t + s],
          [r - s, t + s],
          [r - s, t + 2 * s],
          [r, t + 2 * s],
          [r, b - 2 * s],
          [r - s, b - 2 * s],
          [r - s, b - s],
          [r - 2 * s, b - s],
          [r - 2 * s, b],
          [l + 2 * s, b],
          [l + 2 * s, b - s],
          [l + s, b - s],
          [l + s, b - 2 * s],
          [l, b - 2 * s],
        ];

  return `M${points.map(([x, y]) => `${x} ${y}`).join("L")}Z`;
};

export type NotchProps = ViewProps & {
  corner?: NotchCorner;
  // accent-* classes for the fill and the 1pt outline, e.g. "accent-foreground".
  fillClassName?: string;
  strokeClassName?: string;
};

// A View with stepped (pixel) corners: its fill and outline are an SVG drawn
// behind the children, sized on layout. Use it for buttons, fields and tiles.
export const Notch = ({
  children,
  corner = "md",
  fillClassName,
  onLayout,
  strokeClassName,
  ...props
}: NotchProps) => {
  const [size, setSize] = React.useState({ height: 0, width: 0 });
  const stroked = strokeClassName !== undefined;

  return (
    <View
      onLayout={(event) => {
        const { height, width } = event.nativeEvent.layout;
        setSize({ height, width });
        onLayout?.(event);
      }}
      {...props}
    >
      {size.width > 0 ? (
        <View className="absolute inset-0" pointerEvents="none">
          <Svg height={size.height} width={size.width}>
            <ThemedPath
              d={notchPath(size.width, size.height, corner, stroked ? 0.5 : 0)}
              fill={fillClassName ? undefined : "none"}
              fillClassName={fillClassName}
              strokeClassName={strokeClassName}
              strokeWidth={stroked ? 1 : 0}
            />
          </Svg>
        </View>
      ) : null}
      {children}
    </View>
  );
};
