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
        body: "font-normal leading-6",
        caption: "text-sm font-normal leading-5",
        code: cn(
          "bg-muted relative rounded px-1.5 py-0.5 font-mono text-sm font-semibold"
        ),
        default: "",
        display: "text-5xl font-semibold leading-14 tracking-tight",
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
        label: "text-sm font-semibold leading-5",
        large: "text-lg font-semibold",
        lead: "text-muted-foreground text-xl",
        link: "text-sm font-medium leading-5",
        linkPrimary: "text-primary text-sm font-medium leading-5",
        mono: "font-mono text-xs font-medium leading-4",
        muted: "text-muted-foreground text-sm",
        p: "mt-3 leading-7 sm:mt-6",
        small: "text-sm font-medium leading-none",
        title: "text-3xl font-semibold leading-10 tracking-tight",
      },
    },
  }
);

type TextVariantProps = VariantProps<typeof textVariants>;

type TextVariant = NonNullable<TextVariantProps["variant"]>;

const ROLE: Partial<Record<TextVariant, Role>> = {
  blockquote: Platform.select({ web: "blockquote" as Role }),
  code: Platform.select({ web: "code" as Role }),
  display: "heading",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  title: "heading",
};

const ARIA_LEVEL: Partial<Record<TextVariant, string>> = {
  display: "1",
  h1: "1",
  h2: "2",
  h3: "3",
  h4: "4",
  title: "2",
};

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
      role={variant ? ROLE[variant] : undefined}
      aria-level={variant ? ARIA_LEVEL[variant] : undefined}
      {...props}
    />
  );
};

export { Text, TextClassContext };
