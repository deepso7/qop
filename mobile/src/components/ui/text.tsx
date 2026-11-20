import { Slot } from "@rn-primitives/slot";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";
import { Platform, Text as RNText } from "react-native";
import type { Role } from "react-native";

import { cn } from "@/lib/utils";

// Typography. Pair with a `tone` for colour; the few variants that carry
// their own colour (lead, muted, linkPrimary) keep it unless a tone is set.
const textVariants = cva(
  cn(
    "text-foreground font-sans text-base",
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
        // Inter for reading and actions; Paper Mono for compact metadata and codes.
        action: "font-sans-medium text-base",
        blockquote: "mt-4 border-l-2 pl-3 italic sm:mt-6 sm:pl-6",
        body: "text-subhead font-sans leading-5",
        caption: "font-paper text-faint text-xs leading-4 tabular-nums",
        code: cn(
          "bg-muted font-paper-semibold relative rounded px-1.5 py-0.5 text-sm"
        ),
        default: "",
        display: "tracking-display font-sans-semibold text-3xl leading-9",
        eyebrow: "font-paper text-faint text-xs leading-4",
        // A key fingerprint or code to compare by eye.
        fingerprint: "font-paper-semibold text-lg",
        footnote: "text-xs leading-4",
        glyph: "font-paper text-2xl",
        h1: cn(
          "font-sans-semibold text-center text-4xl tracking-tight",
          Platform.select({ web: "scroll-m-20 text-balance" })
        ),
        h2: cn(
          "border-border font-sans-semibold border-b pb-2 text-3xl tracking-tight",
          Platform.select({ web: "scroll-m-20 first:mt-0" })
        ),
        h3: cn(
          "font-sans-semibold text-2xl tracking-tight",
          Platform.select({ web: "scroll-m-20" })
        ),
        h4: cn(
          "font-sans-semibold text-xl tracking-tight",
          Platform.select({ web: "scroll-m-20" })
        ),
        // iOS headline: conversation titles and chat names.
        headline: "text-headline font-sans-semibold",
        helper: "text-foreground-secondary text-label font-sans leading-4.5",
        inputPrefix: "font-sans text-2xl leading-8",
        largeTitle:
          "font-sans-semibold tracking-large-title text-large-title leading-10",
        heading: "font-sans-semibold text-sm leading-5",
        hero: "tracking-display font-sans-semibold text-3xl leading-9",
        label: "text-label font-sans-medium leading-4.5",
        large: "font-sans-semibold text-lg",
        lead: "text-foreground-secondary text-base leading-6",
        link: "font-sans-medium text-sm leading-5",
        linkPrimary: "text-primary font-sans-medium text-sm leading-5",
        mono: "font-paper-medium text-xs leading-4",
        // Body-size system monospace: commands, peer ids, inline literals.
        monospace: "font-mono",
        muted: "text-muted-foreground text-sm",
        p: "mt-3 leading-7 sm:mt-6",
        readout: "font-paper text-base",
        small: "font-sans-medium text-sm leading-none",
        strong: "font-sans-medium",
        tag: "font-paper text-xs",
        terminal: "font-paper text-xs leading-4",
        title: "font-sans-semibold text-xl leading-6.5 tracking-tight",
      },
    },
  }
);

// Colour. Applied after the variant and any parent TextClassContext (e.g. a
// Button's label colour), so an explicit tone always wins.
const textToneVariants = cva("", {
  defaultVariants: {
    tone: "default",
  },
  variants: {
    tone: {
      default: "",
      destructive: "text-destructive",
      // Text on a foreground-coloured fill (the inverse of the page).
      inverse: "text-background",
      link: "text-link",
      // Text on a bg-primary fill.
      onPrimary: "text-primary-foreground",
      primary: "text-primary",
      // Supporting copy. Also covers text-muted-foreground (same token values).
      secondary: "text-foreground-secondary",
    },
  },
});

type TextVariantProps = VariantProps<typeof textVariants> &
  VariantProps<typeof textToneVariants>;

type TextVariant = NonNullable<VariantProps<typeof textVariants>["variant"]>;

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
  heading: "heading",
  hero: "heading",
  largeTitle: "heading",
  title: "heading",
} satisfies Partial<Record<TextVariant, Role>>;

const ARIA_LEVEL = {
  display: "1",
  h1: "1",
  h2: "2",
  h3: "3",
  h4: "4",
  heading: "1",
  hero: "1",
  largeTitle: "1",
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
  tone,
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
      className={cn(
        textVariants({ variant }),
        textClass,
        textToneVariants({ tone }),
        className
      )}
      role={variant && hasOwn(ROLE, variant) ? ROLE[variant] : undefined}
      aria-level={
        variant && hasOwn(ARIA_LEVEL, variant) ? ARIA_LEVEL[variant] : undefined
      }
      {...props}
    />
  );
};

export { Text, TextClassContext, textToneVariants };
