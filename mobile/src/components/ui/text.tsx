import { Slot } from "@rn-primitives/slot";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";
import { Platform, Text as RNText } from "react-native";
import type { Role } from "react-native";

import { cn } from "@/lib/utils";

const textVariants = cva(
  cn(
    "text-foreground text-base",
    Platform.select({
      web: "select-text",
    })
  ),
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        blockquote: "mt-4 border-l-2 pl-3 italic sm:mt-6 sm:pl-6",
        body: "leading-6 font-normal",
        caption: "text-sm leading-5 font-normal",
        code: cn(
          "bg-muted relative rounded px-1.5 py-0.5 font-mono text-sm font-semibold"
        ),
        default: "",
        display: "text-5xl leading-14 font-semibold tracking-tight",
        h1: cn(
          "text-center text-4xl font-extrabold tracking-tight",
          Platform.select({ web: "scroll-m-20 text-balance" })
        ),
        h2: cn(
          "border-border border-b pb-2 text-3xl font-semibold tracking-tight",
          Platform.select({ web: "scroll-m-20 first:mt-0" })
        ),
        h3: cn(
          "text-2xl font-semibold tracking-tight",
          Platform.select({ web: "scroll-m-20" })
        ),
        h4: cn(
          "text-xl font-semibold tracking-tight",
          Platform.select({ web: "scroll-m-20" })
        ),
        label: "text-sm leading-5 font-semibold",
        large: "text-lg font-semibold",
        lead: "text-muted-foreground text-xl",
        link: "text-sm leading-5 font-medium",
        linkPrimary: "text-primary text-sm leading-5 font-medium",
        mono: "font-mono text-xs leading-4 font-medium",
        muted: "text-muted-foreground text-sm",
        p: "mt-3 leading-7 sm:mt-6",
        small: "text-sm leading-none font-medium",
        title: "text-3xl leading-10 font-semibold tracking-tight",
      },
    },
  }
);

type TextVariantProps = VariantProps<typeof textVariants>;

type TextVariant = NonNullable<TextVariantProps["variant"]>;

const ROLE = {
  // SAFETY: React Native Web accepts the semantic HTML role used for blockquotes.
  blockquote: Platform.select({ web: "blockquote" as Role }),
  // SAFETY: React Native Web accepts the semantic HTML role used for code text.
  code: Platform.select({ web: "code" as Role }),
  display: "heading",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  title: "heading",
} satisfies Partial<Record<TextVariant, Role>>;

const ARIA_LEVEL = {
  display: "1",
  h1: "1",
  h2: "2",
  h3: "3",
  h4: "4",
  title: "2",
} satisfies Partial<Record<TextVariant, string>>;

const hasOwn = <ObjectType extends object>(
  object: ObjectType,
  key: PropertyKey
): key is keyof ObjectType => Object.hasOwn(object, key);

const TextClassContext = React.createContext<string | undefined>(undefined);

const Text = ({
  className,
  asChild = false,
  variant = "default",
  ...props
}: React.ComponentProps<typeof RNText> &
  React.RefAttributes<typeof RNText> &
  TextVariantProps & {
    asChild?: boolean;
  }) => {
  const textClass = React.useContext(TextClassContext);
  const Component = asChild ? Slot : RNText;
  return (
    <Component
      className={cn(textVariants({ variant }), textClass, className)}
      role={variant && hasOwn(ROLE, variant) ? ROLE[variant] : undefined}
      aria-level={
        variant && hasOwn(ARIA_LEVEL, variant) ? ARIA_LEVEL[variant] : undefined
      }
      {...props}
    />
  );
};

export { Text, TextClassContext };
