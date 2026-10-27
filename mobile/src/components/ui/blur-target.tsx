import { BlurTargetView } from "expo-blur";
import * as React from "react";
import type { ViewInstance } from "react-native";
import { withUniwind } from "uniwind";

const StyledBlurTargetView = withUniwind(BlurTargetView);

interface BlurTargetContextValue {
  ref: React.RefObject<ViewInstance | null>;
  setOverlayOpen: (open: boolean) => void;
}

const BlurTargetContext = React.createContext<BlurTargetContextValue | null>(
  null
);

const BlurTargetProvider = ({ children }: React.PropsWithChildren) => {
  const targetRef = React.useRef<ViewInstance | null>(null);
  const [overlayOpen, setOverlayOpen] = React.useState(false);
  const value = React.useMemo(() => ({ ref: targetRef, setOverlayOpen }), []);

  return (
    <BlurTargetContext.Provider value={value}>
      <StyledBlurTargetView
        accessibilityElementsHidden={overlayOpen}
        importantForAccessibility={overlayOpen ? "no-hide-descendants" : "auto"}
        className="flex-1"
        ref={targetRef}
      >
        {children}
      </StyledBlurTargetView>
    </BlurTargetContext.Provider>
  );
};

const useBlurTarget = () => React.use(BlurTargetContext);

export { BlurTargetProvider, useBlurTarget };
