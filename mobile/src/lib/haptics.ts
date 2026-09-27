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
