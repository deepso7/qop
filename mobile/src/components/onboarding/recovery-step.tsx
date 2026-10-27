import { Result } from "effect";
import * as React from "react";
import { Platform, Pressable, Share, View } from "react-native";

import {
  Eyebrow,
  Lede,
  StatusLine,
  StepFrame,
  Title,
} from "@/components/onboarding/chrome";
import { Cursor } from "@/components/pixel/cursor";
import { Notch } from "@/components/pixel/notch";
import { PixelButton } from "@/components/pixel/pixel-button";
import { NativeAlert } from "@/components/ui/native-alert";
import { Text } from "@/components/ui/text";
import { successHaptic } from "@/lib/haptics";
import { useIdentityStore } from "@/lib/identity-store";

// Reads the recovery key from the vault; `retry` starts a fresh read.
const useRecoveryKey = () => {
  const revealRecoveryKey = useIdentityStore(
    (state) => state.revealRecoveryKey
  );

  const [attempt, setAttempt] = React.useState(0);

  const [state, setState] = React.useState<{
    attempt: number;
    error?: string;
    key?: string;
  }>();

  React.useEffect(() => {
    let cancelled = false;

    const read = async () => {
      const result = await revealRecoveryKey();

      if (cancelled) {
        return;
      }

      setState(
        Result.isSuccess(result)
          ? { attempt, key: result.success }
          : { attempt, error: "Couldn’t open the recovery key. Try again." }
      );
    };

    void read();

    return () => {
      cancelled = true;
    };
  }, [attempt, revealRecoveryKey]);

  // Ignore results from an earlier attempt while a retry is loading.
  const current = state?.attempt === attempt ? state : undefined;

  return {
    error: current?.error,
    recoveryKey: current?.key,
    retry: () => setAttempt((value) => value + 1),
  };
};

// Four-character groups read like a printout; export still sends the exact key.
const PREFIX = "qop1_";

// The key's body after its fixed `qop1_` prefix, in groups of four.
const groups = (key: string) =>
  (key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key).match(/.{1,4}/gu) ??
  [];

const RULES = [
  { label: "Keep it", value: "Offline. Paper works; screenshots don’t." },
  { label: "Private", value: "Anyone with it controls your account." },
  { label: "No resets", value: "qop can’t recover it for you." },
];

const KeyTile = ({
  error,
  recoveryKey,
}: {
  error?: string;
  recoveryKey?: string;
}) => {
  const [revealed, setRevealed] = React.useState(false);

  if (error) {
    return <StatusLine tone="error">{error}</StatusLine>;
  }

  if (!recoveryKey) {
    return (
      <Notch
        className="h-32 justify-center p-4"
        fillClassName="accent-code-background"
      >
        <Cursor className="bg-foreground-secondary" />
      </Notch>
    );
  }

  return (
    <Pressable
      accessibilityHint={revealed ? "Hides the key" : "Shows the key"}
      accessibilityLabel={revealed ? recoveryKey : "Recovery key, hidden"}
      accessibilityRole="button"
      onPress={() => setRevealed((value) => !value)}
    >
      <Notch className="gap-4 p-4" fillClassName="accent-code-background">
        <View className="flex-row flex-wrap gap-x-3 gap-y-2">
          {/* The fixed prefix is the same for every key, so it stays dim. */}
          <Text tone="secondary" variant="readout">
            {PREFIX}
          </Text>
          {groups(recoveryKey).map((group, i) => (
            <Text
              // Groups can repeat, so position is the stable identity here.
              key={`${i}-${group}`}
              tone={revealed ? "default" : "secondary"}
              variant="readout"
            >
              {revealed ? group : "••••".slice(0, group.length)}
            </Text>
          ))}
        </View>
        <Text tone="link" variant="tag">
          {revealed ? "tap to hide" : "tap to reveal"}
        </Text>
      </Notch>
    </Pressable>
  );
};

// Step 3: back up the recovery key. Finishing records the backup choice, which
// flips the identity store to ready and the root stack into the app.
export const RecoveryStep = ({ handle }: { handle: string }) => {
  const setBackupState = useIdentityStore((state) => state.setBackupState);
  const { error: keyError, recoveryKey, retry } = useRecoveryKey();
  const [backedUp, setBackedUp] = React.useState(false);
  // Android doesn’t say whether the share went anywhere, so the user confirms.
  const [awaitingConfirmation, setAwaitingConfirmation] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);
  const [skipAlertOpen, setSkipAlertOpen] = React.useState(false);
  const [error, setError] = React.useState<string>();

  const markBackedUp = () => {
    setAwaitingConfirmation(false);
    setBackedUp(true);
    setError(undefined);
    void successHaptic();
  };

  const exportKey = async () => {
    if (!recoveryKey) {
      return;
    }

    try {
      const result = await Share.share({
        message: recoveryKey,
        title: "qop recovery key",
      });

      if (result.action !== Share.sharedAction) {
        return;
      }

      if (Platform.OS === "android") {
        setAwaitingConfirmation(true);
      } else {
        markBackedUp();
      }
    } catch {
      setError("Couldn’t export the recovery key. Try again.");
    }
  };

  const finish = async (backupState: "copied" | "skipped") => {
    if (finishing) {
      return;
    }

    setFinishing(true);
    setError(undefined);
    const result = await setBackupState(backupState);

    if (Result.isFailure(result)) {
      setError("Couldn’t save your choice. Try again.");
      setFinishing(false);
    }
  };

  const footer = backedUp ? (
    <PixelButton
      busy={finishing}
      label="Start messaging"
      onPress={() => {
        void finish("copied");
      }}
      trailing="→"
    />
  ) : (
    <>
      {/* Android can’t tell a share from a dismissed sheet, so export stays
          available beside the confirmation. */}
      {awaitingConfirmation ? (
        <PixelButton label="I saved it" onPress={markBackedUp} />
      ) : null}
      <PixelButton
        accessibilityHint="Opens the share sheet to save the key outside qop"
        busy={!recoveryKey && !keyError}
        label={keyError ? "Try again" : "Export recovery key"}
        onPress={
          keyError
            ? retry
            : () => {
                void exportKey();
              }
        }
        variant={awaitingConfirmation ? "quiet" : "primary"}
      />
      <PixelButton
        disabled={finishing}
        label="I’ll save it later"
        onPress={() => setSkipAlertOpen(true)}
        variant="quiet"
      />
    </>
  );

  return (
    <StepFrame footer={footer} step={3}>
      <View className="gap-4">
        <Eyebrow>Recovery key</Eyebrow>
        <Title>Save your recovery key.</Title>
        <Lede>
          @{handle} is yours. This key is the only way back in if you lose this
          phone.
        </Lede>
      </View>

      <View>
        {RULES.map((rule) => (
          <View
            className="flex-row items-baseline gap-4 py-1.5"
            key={rule.label}
          >
            <Text className="w-24" tone="secondary" variant="eyebrow">
              {rule.label}
            </Text>
            <Text className="flex-1">{rule.value}</Text>
          </View>
        ))}
      </View>

      <View className="gap-3">
        <KeyTile error={keyError} recoveryKey={recoveryKey} />
        {backedUp ? <StatusLine tone="ok">Exported.</StatusLine> : null}
        {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      </View>

      <NativeAlert
        cancelLabel="Back up now"
        confirmLabel="Skip for now"
        description={`Without the recovery key, losing this phone means losing @${handle}. You can export it later from your profile.`}
        destructive
        onConfirm={() => {
          setSkipAlertOpen(false);
          void finish("skipped");
        }}
        onOpenChange={setSkipAlertOpen}
        open={skipAlertOpen}
        title="Skip the backup?"
      />
    </StepFrame>
  );
};
