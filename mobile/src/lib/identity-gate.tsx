import * as React from "react";

// Temporary until identity keys are persisted. Set true to exercise protected
// routes without completing onboarding.
export const BYPASS_ONBOARDING_FOR_TESTING = false;

const readHasIdentityKeys = () =>
  Promise.resolve(BYPASS_ONBOARDING_FOR_TESTING);

interface IdentityGateValue {
  completeOnboardingForSession: () => void;
  hasIdentityKeys: boolean | null;
}

const IdentityGateContext = React.createContext<IdentityGateValue | null>(null);

export const IdentityGateProvider = ({ children }: React.PropsWithChildren) => {
  const [hasIdentityKeys, setHasIdentityKeys] = React.useState<boolean | null>(
    null
  );

  React.useEffect(() => {
    let isMounted = true;

    const loadIdentityState = async () => {
      const hasKeys = await readHasIdentityKeys();
      if (isMounted) {
        setHasIdentityKeys(hasKeys);
      }
    };

    void loadIdentityState();

    return () => {
      isMounted = false;
    };
  }, []);

  const completeOnboardingForSession = React.useCallback(() => {
    setHasIdentityKeys(true);
  }, []);

  const value = React.useMemo(
    () => ({ completeOnboardingForSession, hasIdentityKeys }),
    [completeOnboardingForSession, hasIdentityKeys]
  );

  return (
    <IdentityGateContext.Provider value={value}>
      {children}
    </IdentityGateContext.Provider>
  );
};

export const useIdentityGate = () => {
  const value = React.use(IdentityGateContext);
  if (!value) {
    throw new Error("useIdentityGate must be used inside IdentityGateProvider");
  }
  return value;
};
