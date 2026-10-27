import { Result } from "effect";
import * as React from "react";
import { Keyboard, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { HandleStep } from "@/components/onboarding/handle-step";
import { InviteStep } from "@/components/onboarding/invite-step";
import { RecoveryStep } from "@/components/onboarding/recovery-step";
import { RestoreStep } from "@/components/onboarding/restore-step";
import { VaultError } from "@/components/onboarding/vault-error";
import { Welcome } from "@/components/onboarding/welcome";
import { Cursor } from "@/components/pixel/cursor";
import { primaryHaptic, selectionHaptic } from "@/lib/haptics";
import { useIdentityStore } from "@/lib/identity-store";

// Screens before keys exist; afterwards the identity store picks the screen.
type Stage = "handle" | "invite" | "restore" | "welcome";

// Onboarding from welcome, either creating an account (handle → invite code →
// recovery key) or restoring one (recovery key → add this phone).
const OnboardingRoute = () => {
  const error = useIdentityStore((state) => state.error);
  const identity = useIdentityStore((state) => state.identity);
  const resetIdentity = useIdentityStore((state) => state.resetIdentity);
  const status = useIdentityStore((state) => state.status);
  const [stage, setStage] = React.useState<Stage>("welcome");
  const [handle, setHandle] = React.useState("");

  const goTo = (next: Stage) => {
    Keyboard.dismiss();
    void (next === "welcome" ? selectionHaptic() : primaryHaptic());
    setStage(next);
  };

  // The user never saw these keys (the recovery key only shows after
  // registration), so an unregistered identity is discarded without asking.
  // The stage moves first: while keys exist the route shows the invite step
  // regardless, and once they're gone it must not remount it.
  const backToHandle = async () => {
    Keyboard.dismiss();
    void selectionHaptic();
    setStage("handle");

    if (identity) {
      const previous = identity.handle;

      if (Result.isSuccess(await resetIdentity())) {
        setHandle(previous);
      }
    }
  };

  // A restored identity whose enrollment failed is useless, and the recovery
  // key is what matters, so it is discarded without asking. The stage moves
  // first so the route comes back to key entry, not welcome.
  const restartRestore = () => {
    Keyboard.dismiss();
    void selectionHaptic();
    setStage("restore");
    void resetIdentity();
  };

  let content: React.ReactNode;

  if (status === "resetting" || status === "loading") {
    content = (
      <View
        accessibilityLabel="Loading"
        accessible
        className="flex-1 items-center justify-center"
      >
        <Cursor className="bg-foreground-secondary" />
      </View>
    );
  } else if (status === "error") {
    content = <VaultError error={error} key="error" />;
  } else if (status === "backup" && identity) {
    content = <RecoveryStep handle={identity.handle} key="recovery" />;
  } else if (status === "enrolling" || stage === "restore") {
    // Ahead of the invite step: an identity restored on this phone must never
    // be registered as a new account.
    content = (
      <RestoreStep
        key="restore"
        onBack={() => goTo("welcome")}
        onStartOver={restartRestore}
      />
    );
  } else if (identity || stage === "invite") {
    // Same key before and after the keys are created, so the step keeps its
    // state through the "creating" → "unregistered" transition.
    content = (
      <InviteStep
        handle={identity?.handle ?? handle}
        key="invite"
        onBack={() => {
          void backToHandle();
        }}
      />
    );
  } else if (stage === "handle") {
    content = (
      <HandleStep
        handle={handle}
        key="handle"
        onBack={() => goTo("welcome")}
        onChangeHandle={setHandle}
        onContinue={() => goTo("invite")}
      />
    );
  } else {
    content = (
      <Welcome
        key="welcome"
        onCreate={() => goTo("handle")}
        onRestore={() => goTo("restore")}
      />
    );
  }

  return (
    <View className="bg-background flex-1">
      <KeyboardAvoidingView behavior="padding" className="flex-1">
        {content}
      </KeyboardAvoidingView>
    </View>
  );
};

export default OnboardingRoute;
