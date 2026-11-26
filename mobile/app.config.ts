import type { ExpoConfig } from "expo/config";
import { AndroidConfig, withAndroidManifest } from "expo/config-plugins";

const withAndroidConfigurationChanges = (config: ExpoConfig) =>
  withAndroidManifest(config, (mod) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(
      mod.modResults
    );

    const changes = new Set(
      activity.$["android:configChanges"]?.split("|").filter(Boolean)
    );

    changes.add("fontScale");
    activity.$["android:configChanges"] = [...changes].join("|");

    return mod;
  });

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
    backgroundColor: "#F7EADF",
    identifier: "sh.qop.dev",
    name: "qop dev",
    scheme: "qop-dev",
  },
  preview: {
    backgroundColor: "#F7EADF",
    identifier: "sh.qop.preview",
    name: "qop preview",
    scheme: "qop-preview",
  },
  production: {
    backgroundColor: "#F7EADF",
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
const mailboxPush = process.env.EXPO_PUBLIC_QOP_MAILBOX_PUSH === "1";
const firebaseConfig = process.env.GOOGLE_SERVICES_JSON;

const android: NonNullable<ExpoConfig["android"]> = {
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
};

if (mailboxPush && firebaseConfig) {
  android.googleServicesFile = firebaseConfig;
}

export default withAndroidConfigurationChanges({
  android,
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
    // Camera only scans pairing QR codes, so no microphone access.
    [
      "expo-camera",
      {
        cameraPermission:
          "Scan the QR code shown on a device you want to link to your account.",
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    "expo-font",
    "expo-image",
    [
      "expo-notifications",
      {
        enableBackgroundRemoteNotifications: mailboxPush,
        enableRemoteNotifications: mailboxPush,
        mode:
          process.env.QOP_APNS_ENVIRONMENT === "development"
            ? "development"
            : "production",
      },
    ],
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
    "expo-status-bar",
    "expo-web-browser",
    ["expo-dev-client", { addGeneratedScheme: appVariant === "development" }],
  ],
  scheme: variant.scheme,
  slug: "qop",
  userInterfaceStyle: "automatic",
  version: "0.0.1",
} satisfies ExpoConfig);
