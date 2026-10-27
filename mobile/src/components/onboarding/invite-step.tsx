import { RegistrationAdmissionCode } from "@qop/identity";
import { Effect, Result, Schema } from "effect";
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
import type { LogState } from "@/components/onboarding/chrome";
import { Notch } from "@/components/pixel/notch";
import { PixelButton } from "@/components/pixel/pixel-button";
import { Text } from "@/components/ui/text";
import { primaryHaptic, successHaptic } from "@/lib/haptics";
import { useIdentityStore } from "@/lib/identity-store";
import {
  checkLocalRegistration,
  startLocalRegistration,
} from "@/lib/local-registration";
import type { LocalRegistration } from "@/lib/local-registration";

const decodeAdmissionCode = Schema.decodeUnknownResult(
  RegistrationAdmissionCode
);

const CODE_LENGTH = 6;

// Typed or pasted input ("abc-def", "ABC DEF") as up to six uppercase
// characters. Keeps the last six, so a paste over a full code replaces it.
const normalizeCode = (value: string) =>
  value
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/gu, "")
    .slice(-CODE_LENGTH);

const canStartRegistration = (
  registration: LocalRegistration | null | undefined
) =>
  registration === null ||
  registration?.status === "failed" ||
  registration?.status === "pending";

const getFailureMessage = (failureCode: string | null, handle: string) => {
  switch (failureCode) {
    case "HANDLE_TAKEN": {
      return `@${handle} was just taken. Go back to pick another.`;
    }

    case "RegistrationUnauthorized": {
      return "That code isn’t valid or has already been used.";
    }

    default: {
      return `Registration failed (${failureCode ?? "unknown"}). Try again.`;
    }
  }
};

// Creates the identity keys on first submit (the handle is only a draft until
// then), registers them with the invitation code, and polls until the
// registry confirms. Confirmation rehydrates the store, which moves the route
// on to the recovery step.
const useRegistration = (handle: string) => {
  const createIdentity = useIdentityStore((state) => state.createIdentity);
  const hydrate = useIdentityStore((state) => state.hydrate);
  const identity = useIdentityStore((state) => state.identity);
  const storedRegistration = useIdentityStore((state) => state.registration);
  const ownerAddress = identity?.ownerAddress;

  // The latest result for this identity, ahead of the store's next hydrate.
  const [override, setOverride] = React.useState<{
    ownerAddress: string;
    value: LocalRegistration;
  }>();

  const registration =
    override && override.ownerAddress === ownerAddress
      ? override.value
      : storedRegistration;

  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>();
  const checking = React.useRef(false);
  // Auto-submit and the keyboard's "go" can fire in the same render.
  const submitting = React.useRef(false);

  const accept = React.useCallback(
    (owner: string, next: LocalRegistration) => {
      setOverride({ ownerAddress: owner, value: next });

      if (next.status === "failed") {
        setMessage(getFailureMessage(next.failureCode, next.handle));

        return;
      }

      setMessage(
        next.status === "pending"
          ? "Couldn’t confirm the submission. Enter the code again to retry."
          : undefined
      );

      if (next.status === "confirmed") {
        void successHaptic();
        void hydrate();
      }
    },
    [hydrate]
  );

  // Resolves to the registration result, or undefined when nothing came back.
  const register = async (code: string) => {
    if (submitting.current || Result.isFailure(decodeAdmissionCode(code))) {
      return;
    }

    submitting.current = true;
    Keyboard.dismiss();
    void primaryHaptic();
    setBusy(true);
    setMessage(undefined);
    let owner = ownerAddress;

    if (!owner) {
      const created = await createIdentity(handle);

      if (Result.isFailure(created)) {
        // The store switches onboarding to the vault error screen.
        submitting.current = false;
        setBusy(false);

        return;
      }

      owner = created.success.ownerAddress;
    }

    const result = await Effect.runPromise(
      startLocalRegistration(code).pipe(Effect.result)
    );

    submitting.current = false;
    setBusy(false);

    if (Result.isFailure(result)) {
      setMessage("Couldn’t reach the registry. Check your connection.");

      return;
    }

    accept(owner, result.success);

    return result.success;
  };

  const status = registration?.status;

  React.useEffect(() => {
    if (!ownerAddress || (status !== "submitted" && status !== "pending")) {
      return;
    }

    let mounted = true;

    const check = async () => {
      if (checking.current) {
        return;
      }

      checking.current = true;

      const result = await Effect.runPromise(
        checkLocalRegistration().pipe(Effect.result)
      );

      checking.current = false;

      if (!mounted) {
        return;
      }

      if (Result.isSuccess(result)) {
        accept(ownerAddress, result.success);
      } else {
        setMessage("Couldn’t check the registration. Retrying…");
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
  }, [accept, ownerAddress, status]);

  return {
    busy,
    hasKeys: Boolean(ownerAddress),
    message,
    register,
    registration,
  };
};

// Six notched boxes over one invisible input, so typing, paste and autofill
// all go through a single TextInput. Tapping the row refocuses it, since a
// near-invisible view doesn’t receive touches on iOS.
const CodeBoxes = ({
  onChange,
  onSubmit,
  value,
}: {
  onChange: (value: string) => void;
  onSubmit: () => void;
  value: string;
}) => {
  const input = React.useRef<React.ComponentRef<typeof TextInput>>(null);
  const [focused, setFocused] = React.useState(false);
  const active = focused ? Math.min(value.length, CODE_LENGTH - 1) : -1;

  const box = (index: number) => (
    <Notch
      className="h-16 flex-1 items-center justify-center"
      corner="sm"
      fillClassName="accent-background-element"
      key={index}
      strokeClassName={index === active ? "accent-primary" : "accent-border"}
    >
      <Text variant="glyph">{value[index] ?? ""}</Text>
    </Notch>
  );

  return (
    <Pressable
      accessible={false}
      className="flex-row items-center gap-2"
      onPress={() => input.current?.focus()}
    >
      {/* The input speaks for the boxes, so screen readers skip them. */}
      <View
        accessibilityElementsHidden
        className="flex-1 flex-row items-center gap-2"
        importantForAccessibility="no-hide-descendants"
      >
        {[0, 1, 2].map(box)}
        <Text tone="secondary" variant="glyph">
          –
        </Text>
        {[3, 4, 5].map(box)}
      </View>
      <TextInput
        accessibilityHint="Six letters or numbers"
        accessibilityLabel="Invitation code"
        accessibilityValue={{ text: value }}
        autoCapitalize="characters"
        autoComplete="one-time-code"
        autoCorrect={false}
        autoFocus
        caretHidden
        // Just above the 0.01 alpha below which iOS drops it from VoiceOver.
        className="absolute inset-0 text-transparent opacity-2"
        enterKeyHint="go"
        onBlur={() => setFocused(false)}
        onChangeText={(next) => onChange(normalizeCode(next))}
        onFocus={() => setFocused(true)}
        onSubmitEditing={onSubmit}
        ref={input}
        spellCheck={false}
        textContentType="oneTimeCode"
        value={value}
      />
    </Pressable>
  );
};

// The slow part, shown as a short terminal log so the wait reads as progress.
const RegistrationLog = ({
  handle,
  hasKeys,
  submitted,
}: {
  handle: string;
  hasKeys: boolean;
  submitted: boolean;
}) => {
  let inviteState: LogState = "waiting";

  if (submitted) {
    inviteState = "done";
  } else if (hasKeys) {
    inviteState = "active";
  }

  return (
    <View accessibilityLiveRegion="polite" className="gap-4">
      <Notch className="gap-2 p-4" fillClassName="accent-background-element">
        <LogRow
          label="keys made on this phone"
          state={hasKeys ? "done" : "active"}
        />
        <LogRow label="invite code accepted" state={inviteState} />
        <LogRow
          label={`registering @${handle}`}
          state={submitted ? "active" : "waiting"}
        />
      </Notch>
      <WaitCaption />
    </View>
  );
};

export interface InviteStepProps {
  handle: string;
  // Returns to step 1, discarding any unregistered identity keys.
  onBack: () => void;
}

// Step 2: redeem an invitation code to register the handle on-chain.
export const InviteStep = ({ handle, onBack }: InviteStepProps) => {
  const [code, setCode] = React.useState("");

  const { busy, hasKeys, message, register, registration } =
    useRegistration(handle);

  // Auto-submit closes the keyboard, so screen readers hear errors here.
  React.useEffect(() => {
    if (message) {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [message]);

  const canStart = canStartRegistration(registration);
  const working = busy || !canStart;
  const complete = code.length === CODE_LENGTH;

  // A rejected code is cleared for the next try; a pending one stays to resubmit.
  const submit = async (value: string) => {
    const result = await register(value);

    if (result && result.status !== "pending") {
      setCode("");
    }
  };

  // A full code submits itself; the button stays for retries.
  const changeCode = (next: string) => {
    setCode(next);

    if (next.length === CODE_LENGTH && next !== code) {
      void submit(next);
    }
  };

  // A pending submission may still land on-chain, so keep the identity.
  const canGoBack = !working && registration?.status !== "pending";

  return (
    <StepFrame
      footer={
        working ? null : (
          <PixelButton
            accessibilityHint="Creates your keys and registers the handle"
            disabled={!complete}
            label={`Register @${handle}`}
            onPress={() => {
              void submit(code);
            }}
          />
        )
      }
      onBack={canGoBack ? onBack : undefined}
      step={2}
    >
      <View className="gap-4">
        <Eyebrow>Invitation</Eyebrow>
        <Title>Got an invite?</Title>
        <Lede>
          qop is invite-only for now. Enter your six-character code to claim @
          {handle}. Each code works once.
        </Lede>
      </View>

      <View className="gap-3">
        {working ? (
          <RegistrationLog
            handle={handle}
            hasKeys={hasKeys}
            submitted={!canStart}
          />
        ) : (
          <CodeBoxes
            onChange={changeCode}
            onSubmit={() => {
              void submit(code);
            }}
            value={code}
          />
        )}
        {message ? <StatusLine tone="error">{message}</StatusLine> : null}
      </View>
    </StepFrame>
  );
};
