import { Result } from "effect";
import * as React from "react";
import { View } from "react-native";

import {
  Eyebrow,
  Lede,
  StepFrame,
  Title,
} from "@/components/onboarding/chrome";
import { PixelButton } from "@/components/pixel/pixel-button";
import { NativeAlert } from "@/components/ui/native-alert";
import { useIdentityStore } from "@/lib/identity-store";
import type { IdentityVaultError } from "@/lib/identity-vault";

const MESSAGES = {
  "already-exists": "An account already exists on this phone.",
  availability: "Secure key storage isn’t available on this phone.",
  create: "qop couldn’t generate your keys.",
  decode: "The stored keys couldn’t be verified.",
  delete: "qop couldn’t remove the stored keys.",
  "install-state": "qop couldn’t verify this install.",
  "invalid-handle": "That handle isn’t valid.",
  "missing-identity": "There are no keys to finish setting up.",
  read: "qop couldn’t read your keys from secure storage.",
  sign: "qop couldn’t sign the registration.",
  "stale-install": "Keys from a previous install are locked on this phone.",
  write: "qop couldn’t save your keys securely.",
} satisfies Record<IdentityVaultError["operation"], string>;

// Shown when the identity vault fails; offers a retry, and a reset when the
// stored keys are unreadable or orphaned.
export const VaultError = ({ error }: { error: IdentityVaultError | null }) => {
  const isHydrating = useIdentityStore((state) => state.isHydrating);
  const resetIdentity = useIdentityStore((state) => state.resetIdentity);
  const retryLoad = useIdentityStore((state) => state.retryLoad);
  const [resetting, setResetting] = React.useState(false);
  const [resetAlertOpen, setResetAlertOpen] = React.useState(false);

  const operation = error?.operation;

  const canReset =
    operation === "decode" ||
    operation === "delete" ||
    operation === "stale-install";

  const reset = async () => {
    setResetAlertOpen(false);
    setResetting(true);

    if (Result.isFailure(await resetIdentity())) {
      setResetting(false);
    }
  };

  return (
    <StepFrame
      footer={
        <>
          <PixelButton
            busy={isHydrating}
            label="Try again"
            onPress={retryLoad}
          />
          {canReset ? (
            <PixelButton
              disabled={resetting}
              label="Reset this phone"
              onPress={() => setResetAlertOpen(true)}
              variant="quiet"
            />
          ) : null}
        </>
      }
    >
      <View className="grow justify-end gap-4">
        <Eyebrow tone="destructive">Vault error</Eyebrow>
        <Title>Can’t open your keys.</Title>
        <Lede>
          {operation
            ? MESSAGES[operation]
            : "qop couldn’t open secure key storage."}
        </Lede>
      </View>
      <NativeAlert
        confirmLabel="Delete keys"
        description="This permanently removes the recovery and device keys from this phone. Only continue if you saved the recovery key or want a new account."
        destructive
        onConfirm={() => {
          void reset();
        }}
        onOpenChange={setResetAlertOpen}
        open={resetAlertOpen}
        title="Delete the stored keys?"
      />
    </StepFrame>
  );
};
