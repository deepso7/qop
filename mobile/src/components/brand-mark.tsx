import Svg, { Path, Rect } from "react-native-svg";

type BrandColor = string;

interface QopMarkProps {
  badgeColor?: BrandColor;
  badgeCount?: 0 | 1 | 2;
  color?: BrandColor;
  size?: number;
}

export const QopMark = ({
  badgeColor = "#0D1012",
  badgeCount = 0,
  color = "#B96C45",
  size = 128,
}: QopMarkProps) => (
  <Svg
    accessibilityLabel="qop"
    accessibilityRole="image"
    height={size}
    viewBox="0 0 64 64"
    width={size}
  >
    <Path
      d="M22 17h20v10H22zM17 22h10v20H17zM37 22h10v20H37zM22 37h20v10H22z"
      fill={color}
    />
    {badgeCount >= 1 ? (
      <Rect fill={badgeColor} height={4} width={4} x={47} y={17} />
    ) : null}
    {badgeCount >= 2 ? (
      <Rect fill={badgeColor} height={4} width={4} x={47} y={43} />
    ) : null}
  </Svg>
);

interface QopWordmarkProps {
  color?: BrandColor;
  width?: number;
}

export const QopWordmark = ({
  color = "#B96C45",
  width = 88,
}: QopWordmarkProps) => (
  <Svg
    accessibilityLabel="qop"
    accessibilityRole="image"
    height={(width * 160) / 352}
    viewBox="0 0 352 160"
    width={width}
  >
    <Path
      d="M32 16h64v32H32zM16 32h32v64H16zM80 32h32v112H80zM32 80h64v32H32zM144 16h64v32h-64zM128 32h32v64h-32zM192 32h32v64h-32zM144 80h64v32h-64zM240 16h80v32h-80zM240 16h32v128h-32zM304 32h32v64h-32zM272 80h48v32h-48z"
      fill={color}
    />
  </Svg>
);
