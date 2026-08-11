import type { ConfigContext, ExpoConfig } from "expo/config";

type AppVariant = "development" | "preview" | "production";

const VARIANTS = {
  development: {
    backgroundColor: "#F2EEEA",
    darkBackgroundColor: "#0D1012",
    identifier: "sh.qop.dev",
    name: "qop Dev",
    scheme: "qop-dev",
  },
  preview: {
    backgroundColor: "#F2EEEA",
    darkBackgroundColor: "#0D1012",
    identifier: "sh.qop.preview",
    name: "qop Preview",
    scheme: "qop-preview",
  },
  production: {
    backgroundColor: "#B96C45",
    darkBackgroundColor: "#0D1012",
    identifier: "sh.qop",
    name: "qop",
    scheme: "qop",
  },
} as const satisfies Record<AppVariant, object>;

const getAppVariant = (): AppVariant => {
  const appVariant = process.env.APP_VARIANT ?? "production";
  if (appVariant in VARIANTS) {
    return appVariant as AppVariant;
  }
  throw new Error(`Unknown APP_VARIANT: ${appVariant}`);
};

const createExpoConfig = ({ config }: ConfigContext): ExpoConfig => {
  const appVariant = getAppVariant();
  const variant = VARIANTS[appVariant];
  const iconRoot = `./assets/icons/${appVariant}`;

  return {
    ...config,
    android: {
      ...config.android,
      adaptiveIcon: {
        backgroundColor: variant.backgroundColor,
        foregroundImage: `${iconRoot}/android-foreground.png`,
        monochromeImage: `${iconRoot}/android-monochrome.png`,
      },
      icon: `${iconRoot}/android-legacy.png`,
      package: variant.identifier,
    },
    extra: {
      ...config.extra,
      appVariant,
    },
    icon: `${iconRoot}/ios.png`,
    ios: {
      ...config.ios,
      bundleIdentifier: variant.identifier,
      icon: {
        dark: `${iconRoot}/ios-dark.png`,
        light: `${iconRoot}/ios-light.png`,
      },
    },
    name: variant.name,
    plugins: [
      ...(config.plugins ?? []).filter((plugin) => {
        const name = Array.isArray(plugin) ? plugin[0] : plugin;
        return name !== "expo-secure-store" && name !== "expo-splash-screen";
      }),
      "expo-secure-store",
      [
        "expo-splash-screen",
        {
          backgroundColor: variant.backgroundColor,
          dark: {
            backgroundColor: variant.darkBackgroundColor,
            image: `${iconRoot}/splash-dark.png`,
          },
          image: `${iconRoot}/splash-light.png`,
          imageWidth: 196,
          resizeMode: "contain",
        },
      ],
      [
        "expo-dev-client",
        {
          addGeneratedScheme: appVariant === "development",
        },
      ],
    ],
    scheme: variant.scheme,
    slug: config.slug ?? "qop",
    web: {
      ...config.web,
      favicon: `${iconRoot}/favicon.png`,
    },
  };
};

export default createExpoConfig;
