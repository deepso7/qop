// Welcome art: two qop "o" marks on a diagonal, joined by a dashed wire that
// a terracotta packet crosses one way and then back — peer to peer, nothing in
// the middle. Built once per size and theme; only the packet and the arrival
// flash in the receiving mark's hole animate.
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import {
  cancelAnimation,
  createAnimatedComponent,
  Easing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path, Rect } from "react-native-svg";

import {
  buildPeers,
  easeInOut,
  exchangeAt,
  haloPath,
  holeOf,
  markPath,
  PERIOD,
  wirePath,
} from "@/components/pixel/peers-field";
import { useTheme } from "@/constants/theme";

const AnimatedRect = createAnimatedComponent(Rect);

// Horizontal inset of the marks, matching the screen's copy margin.
const MARGIN = 24;

// Decorative art that fills its parent; transparent background.
export const Peers = () => {
  const colors = useTheme();
  const reduceMotion = useReducedMotion();
  const [size, setSize] = useState({ height: 0, width: 0 });

  const scene = useMemo(
    () =>
      size.width > 0 ? buildPeers(size.width, size.height, MARGIN) : undefined,
    [size.height, size.width]
  );

  const art = useMemo(() => {
    if (!scene) {
      return;
    }

    const { cell, marks, wire } = scene;

    return {
      halo: marks.map((mark) => haloPath(mark, cell)).join(""),
      holes: marks.map(holeOf),
      marks: marks.map((mark) => markPath(mark, cell)).join(""),
      // Flat [x0, y0, x1, y1, …] cells, cheap to read in a worklet.
      route: scene.route.flatMap(({ x, y }) => [x, y]),
      wire: wirePath(wire, cell),
    };
  }, [scene]);

  // Seconds into the exchange; held mid-flight when motion is reduced.
  const clock = useSharedValue(0.7);

  useEffect(() => {
    if (reduceMotion) {
      return;
    }

    clock.set(0);
    clock.set(
      withRepeat(
        withTiming(PERIOD, { duration: PERIOD * 1000, easing: Easing.linear }),
        -1
      )
    );

    return () => cancelAnimation(clock);
  }, [clock, reduceMotion]);

  const cell = scene?.cell ?? 0;
  const route = art?.route ?? [];
  const holes = art?.holes ?? [];

  // The packet (3 cells square) centred on the route at eased `progress`,
  // interpolated between route samples so it glides instead of hopping cells.
  const packetProps = useAnimatedProps(() => {
    const { progress } = exchangeAt(clock.get());
    const count = route.length / 2;

    if (progress < 0 || count < 2) {
      return { opacity: 0, x: 0, y: 0 };
    }

    const at = easeInOut(progress) * (count - 1);
    const i = Math.min(Math.floor(at), count - 2);
    const t = at - i;
    const x = (route[i * 2] ?? 0) * (1 - t) + (route[i * 2 + 2] ?? 0) * t;
    const y = (route[i * 2 + 1] ?? 0) * (1 - t) + (route[i * 2 + 3] ?? 0) * t;

    // The wire cell for route point p spans p..p+1, so a 3-cell packet
    // centred on it starts one cell back.
    return { opacity: 1, x: (x - 1) * cell, y: (y - 1) * cell };
  });

  const firstHoleProps = useAnimatedProps(() => ({
    opacity: exchangeAt(clock.get()).lit === 0 ? 1 : 0,
  }));

  const secondHoleProps = useAnimatedProps(() => ({
    opacity: exchangeAt(clock.get()).lit === 1 ? 1 : 0,
  }));

  return (
    <View
      accessibilityElementsHidden
      className="absolute inset-0"
      importantForAccessibility="no-hide-descendants"
      onLayout={({ nativeEvent: { layout } }) =>
        setSize({ height: layout.height, width: layout.width })
      }
      pointerEvents="none"
    >
      {art ? (
        <Svg height={size.height} width={size.width}>
          <Path d={art.wire} fill={colors.textSecondary} />
          <Path d={art.halo} fill={colors.textSecondary} />
          <Path d={art.marks} fill={colors.text} />
          {[firstHoleProps, secondHoleProps].map((animatedProps, i) => {
            const hole = holes[i];

            return hole ? (
              <AnimatedRect
                animatedProps={animatedProps}
                fill={colors.primary}
                height={hole.size * cell}
                key={hole.x}
                width={hole.size * cell}
                x={hole.x * cell}
                y={hole.y * cell}
              />
            ) : null;
          })}
          <AnimatedRect
            animatedProps={packetProps}
            fill={colors.primary}
            height={cell * 3}
            width={cell * 3}
          />
        </Svg>
      ) : null}
    </View>
  );
};
