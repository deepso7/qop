import { Handle } from "@qop/identity";
import { Effect, Result, Schema } from "effect";
import * as React from "react";
import { TextInput, View } from "react-native";

import {
  Eyebrow,
  Lede,
  StatusLine,
  StepFrame,
  Title,
} from "@/components/onboarding/chrome";
import { Notch } from "@/components/pixel/notch";
import { PixelButton } from "@/components/pixel/pixel-button";
import { Text } from "@/components/ui/text";
import { lookupHandle } from "@/lib/registry";

const decodeHandle = Schema.decodeUnknownResult(Handle);

const MAX_LENGTH = 32;

type Availability = "available" | "checking" | "taken" | "unknown";

// Debounced on-chain lookup so taken handles surface while typing. Registration
// stays the source of truth (in-flight registrations aren’t on-chain yet), so
// lookup failures resolve to "unknown" rather than blocking.
const useHandleAvailability = (handle: string, isValid: boolean) => {
  const [checked, setChecked] = React.useState<{
    availability: Exclude<Availability, "checking">;
    handle: string;
  }>();

  React.useEffect(() => {
    if (!isValid) {
      return;
    }

    let cancelled = false;

    const timer = setTimeout(async () => {
      const lookup = await Effect.runPromise(
        lookupHandle(handle).pipe(Effect.result)
      );

      if (cancelled) {
        return;
      }

      let availability: Exclude<Availability, "checking"> = "unknown";

      if (Result.isSuccess(lookup)) {
        availability = lookup.success === null ? "available" : "taken";
      }

      setChecked({ availability, handle });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [handle, isValid]);

  if (!isValid) {
    return;
  }

  return checked?.handle === handle ? checked.availability : "checking";
};

// Why a non-empty handle fails the Handle schema, in the order users hit it.
const getInvalidHint = (handle: string) => {
  if (handle.length > MAX_LENGTH) {
    return `Keep it to ${MAX_LENGTH} characters or fewer.`;
  }

  if (!/^[a-z0-9]/u.test(handle)) {
    return "Start with a letter or number.";
  }

  return "Only letters, numbers and _.";
};

const HandleStatus = ({
  availability,
  handle,
  isValid,
}: {
  availability: Availability | undefined;
  handle: string;
  isValid: boolean;
}) => {
  if (handle.length === 0) {
    return <StatusLine>Letters, numbers and _.</StatusLine>;
  }

  if (!isValid) {
    return <StatusLine tone="error">{getInvalidHint(handle)}</StatusLine>;
  }

  switch (availability) {
    case "available": {
      return <StatusLine tone="ok">@{handle} is free.</StatusLine>;
    }

    case "taken": {
      return <StatusLine tone="error">@{handle} is taken.</StatusLine>;
    }

    case "unknown": {
      return <StatusLine>We’ll confirm it when you register.</StatusLine>;
    }

    default: {
      return <StatusLine>Checking @{handle}…</StatusLine>;
    }
  }
};

export interface HandleStepProps {
  handle: string;
  onBack: () => void;
  onChangeHandle: (handle: string) => void;
  onContinue: () => void;
}

// Step 1: pick the permanent @handle, with a live availability check.
export const HandleStep = ({
  handle,
  onBack,
  onChangeHandle,
  onContinue,
}: HandleStepProps) => {
  const [focused, setFocused] = React.useState(false);
  const isValid = Result.isSuccess(decodeHandle(handle));
  const availability = useHandleAvailability(handle, isValid);
  const canContinue = isValid && availability !== "taken";

  const submit = () => {
    if (canContinue) {
      onContinue();
    }
  };

  return (
    <StepFrame
      footer={
        <PixelButton
          disabled={!canContinue}
          label="Continue"
          onPress={submit}
          trailing="→"
        />
      }
      onBack={onBack}
      step={1}
    >
      <View className="gap-4">
        <Eyebrow>Your handle</Eyebrow>
        <Title>Pick a handle.</Title>
        <Lede>It’s how people find you on qop, and it’s yours for good.</Lede>
      </View>

      <View className="gap-3">
        <Notch
          className="h-16 flex-row items-center gap-1 px-4"
          fillClassName="accent-background-element"
          strokeClassName={focused ? "accent-primary" : "accent-border"}
        >
          <Text tone="secondary" variant="glyph">
            @
          </Text>
          <TextInput
            accessibilityHint="Letters, numbers and underscores"
            accessibilityLabel="qop handle"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            autoFocus
            className="font-paper text-foreground h-full flex-1 text-2xl"
            enterKeyHint="next"
            maxLength={MAX_LENGTH + 1}
            onBlur={() => setFocused(false)}
            onChangeText={(value) => onChangeHandle(value.toLowerCase())}
            onFocus={() => setFocused(true)}
            onSubmitEditing={submit}
            placeholder="you"
            placeholderTextColorClassName="accent-muted-foreground"
            returnKeyType="next"
            selectionColorClassName="accent-primary"
            spellCheck={false}
            submitBehavior="submit"
            value={handle}
          />
        </Notch>
        <View className="flex-row items-center gap-4">
          <View className="flex-1">
            <HandleStatus
              availability={availability}
              handle={handle}
              isValid={isValid}
            />
          </View>
          <Text tone="secondary" variant="tag">
            {handle.length}/{MAX_LENGTH}
          </Text>
        </View>
      </View>
    </StepFrame>
  );
};
