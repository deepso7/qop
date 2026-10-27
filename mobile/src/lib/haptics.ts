import * as Haptics from "expo-haptics";

// Feedback must never prevent an action on devices without a haptic engine.
export const selectionHaptic = async () => {
  try {
    await Haptics.selectionAsync();
  } catch {
    // Unsupported devices can complete the action without tactile feedback.
  }
};

export const successHaptic = async () => {
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {
    // Unsupported devices can complete the action without tactile feedback.
  }
};

// A firmer tap for primary actions that move the user forward.
export const primaryHaptic = async () => {
  try {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  } catch {
    // Unsupported devices can complete the action without tactile feedback.
  }
};
