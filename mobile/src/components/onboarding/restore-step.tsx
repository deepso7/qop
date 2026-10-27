import { Effect, Result } from "effect";
import * as Clipboard from "expo-clipboard";
import * as React from "react";
import {
  AccessibilityInfo,
  Keyboard,
  Pressable,
  TextInput,
  View,
} from "react-native";

import {
  Eyebrow,
  Lede,
  LogRow,
  StatusLine,
  StepFrame,
  Title,
  WaitCaption,
} from "@/components/onboarding/chrome";
import { Notch } from "@/components/pixel/notch";
import { PixelButton } from "@/components/pixel/pixel-button";
import { Text } from "@/components/ui/text";
import { primaryHaptic, successHaptic } from "@/lib/haptics";
import { useIdentityStore } from "@/lib/identity-store";
import {
  checkLocalEnrollment,
  findRecoveryAccount,
  startLocalEnrollment,
} from "@/lib/local-enrollment";
import type {
  LocalEnrollment,
  LocalEnrollmentError,
  RecoveryAccount,
} from "@/lib/local-enrollment";

const KEY_PREFIX = "qop1_";
const KEY_LENGTH = 57;
const KEY_PATTERN = /^qop1_[A-Za-z0-9_-]{43}_[0-9a-f]{8}$/u;

const NETWORK_MESSAGE = "Couldn’t reach the registry. Check your connection.";

// Keys are shown in 4-character groups, so pastes can carry spaces and newlines.
const normalizeKey = (value: string) => value.replaceAll(/\s/gu, "");

const getLookupMessage = (error: LocalEnrollmentError) => {
  switch (error.operation) {
    case "invalid-key": {
      return "That key doesn’t check out. Look for typos.";
    }

    case "network": {
      return NETWORK_MESSAGE;
    }

    default: {
      return "Couldn’t look up this key. Try again.";
    }
  }
};

const getFailureMessage = (failureCode: string | null, handle: string) => {
  switch (failureCode) {
    case "MAX_DEVICES": {
      return `@${handle} has no room for another device. Remove one from another device, then try again.`;
    }

    case "OWNER_CHANGED": {
      return `@${handle}’s recovery key changed. Use the new one.`;
    }

    case "EXPIRED": {
      return "The request expired before it went through. Try again.";
    }

    case "REVERTED":
    case "REJECTED": {
      return "The registry turned this phone down. Try again.";
    }

    default: {
      return `Adding this phone failed (${failureCode ?? "unknown"}). Try again.`;
    }
  }
};

// Live format hint for the key field; the checksum is verified on lookup.
const KeyFormat = ({ recoveryKey }: { recoveryKey: string }) => {
  if (recoveryKey.length === 0) {
    return <StatusLine>Starts with {KEY_PREFIX}</StatusLine>;
  }

  if (KEY_PATTERN.test(recoveryKey)) {
    return <StatusLine tone="ok">Looks like a recovery key.</StatusLine>;
  }

  if (!KEY_PREFIX.startsWith(recoveryKey.slice(0, KEY_PREFIX.length))) {
    return (
      <StatusLine tone="error">
        Recovery keys start with {KEY_PREFIX}
      </StatusLine>
    );
  }

  if (recoveryKey.length < KEY_LENGTH) {
    return (
      <StatusLine>
        {recoveryKey.length} of {KEY_LENGTH} characters
      </StatusLine>
    );
  }

  return (
    <StatusLine tone="error">That doesn’t look like a recovery key.</StatusLine>
  );
};

// Multiline mono field for the key, with suggestions and autofill off, and a
// paste action inside it: long-press menus are easy to miss.
const KeyField = ({
  onChange,
  onPaste,
  onSubmit,
  value,
}: {
  onChange: (value: string) => void;
  onPaste: () => void;
  onSubmit: () => void;
  value: string;
}) => {
  const [focused, setFocused] = React.useState(false);

  return (
    <Notch
      className="min-h-32 px-4 py-3"
      fillClassName="accent-background-element"
      strokeClassName={focused ? "accent-primary" : "accent-border"}
    >
      <TextInput
        accessibilityHint="Paste the key that starts with qop1_"
        accessibilityLabel="Recovery key"
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect={false}
        autoFocus
        className="font-paper text-foreground min-h-26 text-lg leading-7"
        enterKeyHint="go"
        importantForAutofill="no"
        multiline
        onBlur={() => setFocused(false)}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onSubmitEditing={onSubmit}
        placeholder="qop1_…"
        placeholderTextColorClassName="accent-muted-foreground"
        selectionColorClassName="accent-primary"
        spellCheck={false}
        submitBehavior="blurAndSubmit"
        textAlignVertical="top"
        value={value}
      />
      <Pressable
        accessibilityHint="Pastes the key from your clipboard"
        accessibilityLabel="Paste"
        accessibilityRole="button"
        className="self-end"
        hitSlop={12}
        onPress={onPaste}
      >
        {({ pressed }) => (
          <Text tone={pressed ? "default" : "link"} variant="tag">
            [ paste ]
          </Text>
        )}
      </Pressable>
    </Notch>
  );
};

// Restores the identity from the recovery key with a fresh device key, submits
// this phone's enrollment, and polls until the registry confirms it.
// Confirmation rehydrates the store, which leaves onboarding.
const useEnrollment = () => {
  const hydrate = useIdentityStore((state) => state.hydrate);
  const identity = useIdentityStore((state) => state.identity);
  const restoreIdentity = useIdentityStore((state) => state.restoreIdentity);
  const storedEnrollment = useIdentityStore((state) => state.enrollment);

  // The latest result, ahead of the store's next hydrate.
  const [latest, setLatest] = React.useState<LocalEnrollment>();
  const enrollment = latest ?? storedEnrollment;
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>();
  const checking = React.useRef(false);
  // Guards against double taps while an action is in flight.
  const acting = React.useRef(false);

  const accept = React.useCallback(
    (next: LocalEnrollment) => {
      setLatest(next);
      setMessage(undefined);

      if (next.status === "confirmed") {
        void successHaptic();
        void hydrate();
      }
    },
    [hydrate]
  );

  // Runs one action at a time behind the busy cursor; undefined if one was
  // already running.
  const act = async <A,>(work: () => Promise<A>) => {
    if (acting.current) {
      return;
    }

    acting.current = true;
    Keyboard.dismiss();
    void primaryHaptic();
    setBusy(true);
    setMessage(undefined);
    const result = await work();
    acting.current = false;
    setBusy(false);

    return result;
  };

  const submitEnrollment = async () => {
    const result = await Effect.runPromise(
      startLocalEnrollment().pipe(Effect.result)
    );

    if (Result.isFailure(result)) {
      setMessage(
        result.failure.operation === "network"
          ? NETWORK_MESSAGE
          : "Couldn’t add this phone. Try again."
      );

      return;
    }

    accept(result.success);
  };

  // Resolves to the account for this key, or undefined after setting a message.
  const findAccount = (recoveryKey: string) =>
    act(async () => {
      const result = await Effect.runPromise(
        findRecoveryAccount(recoveryKey).pipe(Effect.result)
      );

      if (Result.isFailure(result)) {
        setMessage(getLookupMessage(result.failure));

        return;
      }

      if (result.success === null) {
        setMessage("No account uses this key.");

        return;
      }

      return result.success;
    });

  const addPhone = (recoveryKey: string, handle: string) =>
    act(async () => {
      const restored = await restoreIdentity(recoveryKey, handle);

      // On failure the store switches onboarding to the vault error screen.
      if (Result.isSuccess(restored)) {
        await submitEnrollment();
      }
    });

  const retryEnrollment = () => act(submitEnrollment);

  const status = enrollment?.status;

  React.useEffect(() => {
    if (status !== "submitted") {
      return;
    }

    let mounted = true;

    const check = async () => {
      if (checking.current) {
        return;
      }

      checking.current = true;

      const result = await Effect.runPromise(
        checkLocalEnrollment().pipe(Effect.result)
      );

      checking.current = false;

      if (!mounted) {
        return;
      }

      if (Result.isSuccess(result)) {
        accept(result.success);
      } else {
        setMessage("Couldn’t check on this phone. Retrying…");
      }
    };

    void check();

    const interval = setInterval(() => {
      void check();
    }, 4000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [accept, status]);

  // A restored identity can be left without a record to poll, e.g. offline or
  // after a restart between restoring and submitting.
  const stalled = identity !== null && !busy && enrollment === null;
  let shownMessage = message;

  // A failed record explains itself, including one stored before a restart.
  if (enrollment?.status === "failed") {
    shownMessage = getFailureMessage(enrollment.failureCode, enrollment.handle);
  } else if (stalled && !shownMessage) {
    shownMessage = "This phone isn’t added yet. Try again.";
  }

  return {
    addPhone,
    busy,
    clearMessage: () => setMessage(undefined),
    enrollment,
    findAccount,
    identity,
    message: shownMessage,
    retryEnrollment,
    stalled,
  };
};

// Label/value rows describing what adding this phone does.
const AccountFacts = ({ account }: { account: RecoveryAccount }) => (
  <View>
    {[
      {
        label: "Devices",
        value: `${account.deviceCount} of ${account.maxDevices}`,
      },
      { label: "This phone", value: "Gets its own device key." },
      { label: "Others", value: "Keep working as they are." },
    ].map((row) => (
      <View className="flex-row items-baseline gap-4 py-1.5" key={row.label}>
        <Text className="w-24" tone="secondary" variant="eyebrow">
          {row.label}
        </Text>
        <Text className="flex-1">{row.value}</Text>
      </View>
    ))}
  </View>
);

// The last step: a terminal log while the registry adds this phone, with a
// way out when it fails or never got submitted.
// Retrying keeps this phone's key and device key: a failed or stalled add
// never landed, so the same device can simply be submitted again. Only a
// changed owner needs a different key.
const AddingPhone = ({
  busy,
  failureCode,
  handle,
  message,
  onRetry,
  onStartOver,
  stopped,
}: {
  busy: boolean;
  failureCode: string | null;
  handle: string;
  message: string | undefined;
  onRetry: () => void;
  onStartOver: () => void;
  stopped: boolean;
}) => {
  const footer = stopped ? (
    <>
      {failureCode === "OWNER_CHANGED" ? null : (
        <PixelButton busy={busy} label="Try again" onPress={onRetry} />
      )}
      {busy ? null : (
        <PixelButton
          label="Use a different key"
          onPress={onStartOver}
          variant={failureCode === "OWNER_CHANGED" ? "primary" : "quiet"}
        />
      )}
    </>
  ) : null;

  return (
    <StepFrame footer={footer} step={3}>
      <View className="gap-4">
        <Eyebrow>Restore</Eyebrow>
        <Title>Adding this phone.</Title>
        <Lede>
          This phone joins @{handle} with its own device key. Your other devices
          keep working.
        </Lede>
      </View>

      <View className="gap-3">
        <View accessibilityLiveRegion="polite" className="gap-4">
          <Notch
            className="gap-2 p-4"
            fillClassName="accent-background-element"
          >
            <LogRow label="key verified" state="done" />
            <LogRow label="this phone’s device key made" state="done" />
            <LogRow
              label={`adding this phone to @${handle}`}
              state={stopped && !busy ? "failed" : "active"}
            />
          </Notch>
          {stopped && !busy ? null : <WaitCaption />}
        </View>
        {message ? <StatusLine tone="error">{message}</StatusLine> : null}
      </View>
    </StepFrame>
  );
};

export interface RestoreStepProps {
  // Leaves key entry for the welcome screen.
  onBack: () => void;
  // Discards this phone's restored identity and restarts at key entry.
  onStartOver: () => void;
}

// Restore an existing account: paste the recovery key, confirm the account it
// controls, then add this phone as a device. Mounted with status "enrolling"
// (an identity restored on this phone), it opens on the progress log.
export const RestoreStep = ({ onBack, onStartOver }: RestoreStepProps) => {
  const [input, setInput] = React.useState("");
  const [account, setAccount] = React.useState<RecoveryAccount>();

  const {
    addPhone,
    busy,
    clearMessage,
    enrollment,
    findAccount,
    identity,
    message,
    retryEnrollment,
    stalled,
  } = useEnrollment();

  const recoveryKey = normalizeKey(input);
  const validFormat = KEY_PATTERN.test(recoveryKey);

  // Lookups and enrollment run with the keyboard closed, so screen readers
  // hear errors here.
  React.useEffect(() => {
    if (message) {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [message]);

  const lookUp = async (key: string) => {
    if (!KEY_PATTERN.test(key)) {
      return;
    }

    setAccount(await findAccount(key));
  };

  // A pasted key that checks out goes straight to the lookup.
  const paste = async () => {
    const pasted = await Clipboard.getStringAsync();

    setInput(pasted);
    clearMessage();
    void lookUp(normalizeKey(pasted));
  };

  if (identity) {
    return (
      <AddingPhone
        busy={busy}
        failureCode={
          enrollment?.status === "failed" ? enrollment.failureCode : null
        }
        handle={enrollment?.handle ?? identity.handle}
        message={message}
        onRetry={() => {
          void retryEnrollment();
        }}
        onStartOver={onStartOver}
        stopped={enrollment?.status === "failed" || stalled}
      />
    );
  }

  if (account) {
    const full = account.deviceCount >= account.maxDevices;

    return (
      <StepFrame
        footer={
          <>
            <PixelButton
              accessibilityHint="Makes a device key for this phone and adds it to the account"
              busy={busy}
              disabled={full}
              label="Yes, add this phone"
              onPress={() => {
                void addPhone(recoveryKey, account.handle);
              }}
            />
            {busy ? null : (
              <PixelButton
                label="Not me, use a different key"
                onPress={() => setAccount(undefined)}
                variant="quiet"
              />
            )}
          </>
        }
        onBack={busy ? undefined : () => setAccount(undefined)}
        step={2}
      >
        <View className="gap-4">
          <Eyebrow>Is this you?</Eyebrow>
          <Title>@{account.handle}</Title>
          <Lede>Your recovery key controls this account.</Lede>
        </View>

        <AccountFacts account={account} />

        {full ? (
          <StatusLine tone="error">
            @{account.handle} already has {account.maxDevices} devices. Remove
            one from another device first.
          </StatusLine>
        ) : null}
        {message ? <StatusLine tone="error">{message}</StatusLine> : null}
      </StepFrame>
    );
  }

  return (
    <StepFrame
      footer={
        <PixelButton
          busy={busy}
          disabled={!validFormat}
          label="Find my account"
          onPress={() => {
            void lookUp(recoveryKey);
          }}
          trailing="→"
        />
      }
      onBack={busy ? undefined : onBack}
      step={1}
    >
      <View className="gap-4">
        <Eyebrow>Restore</Eyebrow>
        <Title>Welcome back.</Title>
        <Lede>
          Paste your recovery key to bring your account to this phone. It starts
          with {KEY_PREFIX}
        </Lede>
      </View>

      <View className="gap-3">
        <KeyField
          onChange={(value) => {
            setInput(value);
            clearMessage();
          }}
          onPaste={() => {
            void paste();
          }}
          onSubmit={() => {
            void lookUp(recoveryKey);
          }}
          value={input}
        />
        {message ? (
          <StatusLine tone="error">{message}</StatusLine>
        ) : (
          <KeyFormat recoveryKey={recoveryKey} />
        )}
      </View>
    </StepFrame>
  );
};
