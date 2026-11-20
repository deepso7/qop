import type { AndroidConfig, ExportedConfig } from "expo/config-plugins";
import { describe, expect, it } from "vitest";

import appConfig from "../app.config";

const applyManifest = async (
  modResults: AndroidConfig.Manifest.AndroidManifest
) => {
  const config: ExportedConfig = appConfig;
  const manifestMod = config.mods?.android?.manifest;

  if (!manifestMod) {
    throw new Error("Missing Android manifest mod");
  }

  const result = await manifestMod({
    ...appConfig,
    modRawConfig: appConfig,
    modRequest: {
      introspect: true,
      modName: "manifest",
      platform: "android",
      platformProjectRoot: "android",
      projectRoot: ".",
    },
    modResults,
  });

  return result.modResults.manifest.application?.[0]?.activity?.[0]?.$[
    "android:configChanges"
  ];
};

const manifestWithChanges = (
  changes?: string
): AndroidConfig.Manifest.AndroidManifest => ({
  manifest: {
    $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
    queries: [],
    application: [
      {
        $: { "android:name": ".MainApplication" },
        activity: [
          {
            $: {
              "android:configChanges": changes,
              "android:name": ".MainActivity",
            },
          },
        ],
      },
    ],
  },
});

describe("Android configuration changes", () => {
  it("preserves existing flags while handling font scaling", async () => {
    expect(
      await applyManifest(manifestWithChanges("orientation|uiMode|density"))
    ).toBe("orientation|uiMode|density|fontScale");
  });

  it.each([undefined, ""])(
    "handles an empty configChanges value: %s",
    async (changes) => {
      expect(await applyManifest(manifestWithChanges(changes))).toBe(
        "fontScale"
      );
    }
  );

  it("is idempotent when scaling flags are already present", async () => {
    const manifest = manifestWithChanges("fontScale|orientation|density");

    await applyManifest(manifest);
    expect(await applyManifest(manifest)).toBe("fontScale|orientation|density");
  });

  it("fails if MainActivity is missing", async () => {
    const manifest = manifestWithChanges();
    manifest.manifest.application = [];

    await expect(applyManifest(manifest)).rejects.toThrow(
      "AndroidManifest.xml is missing the required MainActivity element"
    );
  });
});
