import { BlurTargetView } from "expo-blur";
import * as React from "react";
import type { View } from "react-native";

type BlurTargetContextValue = {
  ref: React.RefObject<View | null>;
  setOverlayOpen: (open: boolean) => void;
};

const BlurTargetContext = React.createContext<BlurTargetContextValue | null>(null);

const BlurTargetProvider = ({ children }: React.PropsWithChildren) => {
  const targetRef = React.useRef<View | null>(null);
  const [overlayOpen, setOverlayOpen] = React.useState(false);
  const value = React.useMemo(
    () => ({ ref: targetRef, setOverlayOpen }),
    []
  );

  return (
    <BlurTargetContext.Provider value={value}>
      <BlurTargetView
        accessibilityElementsHidden={overlayOpen}
        importantForAccessibility={overlayOpen ? "no-hide-descendants" : "auto"}
        ref={targetRef}
        style={{ flex: 1 }}
      >
        {children}
      </BlurTargetView>
    </BlurTargetContext.Provider>
  );
};

const useBlurTarget = () => React.use(BlurTargetContext);

export { BlurTargetProvider, useBlurTarget };
