import type {
  PressableProps,
  PressableStateCallbackType,
  StyleProp,
  ViewStyle,
} from "react-native";

type PressableStyleCallback = (
  state: PressableStateCallbackType
) => StyleProp<ViewStyle>;

export const isPressableStyleCallback = (
  style: PressableProps["style"]
): style is PressableStyleCallback => typeof style === "function";
