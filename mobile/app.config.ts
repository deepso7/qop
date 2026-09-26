import type { ExpoConfig } from "expo/config";

// Single source of app config. Pick a variant with APP_VARIANT (defaults to production).
type AppVariant = "development" | "preview" | "production";
interface AppVariantConfig {
  readonly backgroundColor: string;
  readonly identifier: string;
  readonly name: string;
  readonly scheme: string;
}

const VARIANTS = {
  development: {
    backgroundColor: "#F2EEEA",
    identifier: "sh.qop.dev",
    name: "qop Dev",
    scheme: "qop-dev",
  },
  preview: {
    backgroundColor: "#F2EEEA",
    identifier: "sh.qop.preview",
    name: "qop Preview",
    scheme: "qop-preview",
  },
  production: {
    backgroundColor: "#B96C45",
    identifier: "sh.qop",
    name: "qop",
    scheme: "qop",
  },
} as const satisfies Record<AppVariant, AppVariantConfig>;

const DARK_BACKGROUND_COLOR = "#0D1012";

const isAppVariant = (value: string): value is AppVariant =>
  Object.hasOwn(VARIANTS, value);

const getAppVariant = (): AppVariant => {
  const appVariant = process.env.APP_VARIANT ?? "production";
  if (isAppVariant(appVariant)) {
    return appVariant;
  }
  throw new Error(`Unknown APP_VARIANT: ${appVariant}`);
};

const appVariant = getAppVariant();
const variant = VARIANTS[appVariant];
const iconRoot = `./assets/icons/${appVariant}`;

export default {
  android: {
    adaptiveIcon: {
      backgroundColor: variant.backgroundColor,
      foregroundImage: `${iconRoot}/android-foreground.png`,
      monochromeImage: `${iconRoot}/android-monochrome.png`,
    },
    icon: `${iconRoot}/android-legacy.png`,
    package: variant.identifier,
    permissions: [
      "android.permission.ACCESS_WIFI_STATE",
      "android.permission.CHANGE_WIFI_MULTICAST_STATE",
    ],
    predictiveBackGestureEnabled: false,
  },
  experiments: {
    reactCompiler: true,
    typedRoutes: true,
  },
  extra: {
    eas: {
      projectId: "64318cc0-3870-4d04-a70a-93a49a0e78d7",
    },
  },
  icon: `${iconRoot}/ios.png`,
  ios: {
    bundleIdentifier: variant.identifier,
    icon: {
      dark: `${iconRoot}/ios-dark.png`,
      light: `${iconRoot}/ios-light.png`,
    },
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSBonjourServices: ["_p2p._udp"],
      NSLocalNetworkUsageDescription:
        "Discover nearby minip2p peers on your local network.",
    },
    supportsTablet: true,
  },
  name: variant.name,
  orientation: "portrait",
  platforms: ["ios", "android"],
  plugins: [
    "expo-router",
    "expo-font",
    "expo-secure-store",
    "expo-sqlite",
    [
      "expo-splash-screen",
      {
        backgroundColor: variant.backgroundColor,
        dark: {
          backgroundColor: DARK_BACKGROUND_COLOR,
          image: `${iconRoot}/splash-dark.png`,
        },
        image: `${iconRoot}/splash-light.png`,
        imageWidth: 196,
        resizeMode: "contain",
      },
    ],
    ["expo-dev-client", { addGeneratedScheme: appVariant === "development" }],
  ],
  scheme: variant.scheme,
  slug: "qop",
  userInterfaceStyle: "automatic",
  version: "0.0.1",
} satisfies ExpoConfig;
