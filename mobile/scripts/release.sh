#!/usr/bin/env bash
# Build locally and publish a variant with EAS.
# Usage: scripts/release.sh <profile> [ios|android]   (platform defaults to ios)
# e.g.   pnpm release:preview
set -euo pipefail

profile="${1:?usage: release.sh <profile> [ios|android]}"
platform="${2:-ios}"

cd "$(dirname "$0")/.."

# eas submit reads app.config.ts outside the build profile's env, so pin the
# variant for it to resolve the right bundle identifier and stored API key.
export APP_VARIANT="$profile"
# CocoaPods crashes under a non-UTF-8 locale; EAS only sets LANG, which a
# C/POSIX LC_CTYPE or LC_ALL from the shell still overrides.
export LC_ALL=en_US.UTF-8

case "$platform" in
  ios)
    artifact="./build-$profile.ipa"
    # Xcode 26 + macOS 27 CLT mismatch: pin clang to Xcode's SDK. Drop after Xcode 27.
    SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" \
      pnpm eas build -p ios --profile "$profile" --local --non-interactive --output "$artifact"
    pnpm eas submit -p ios --profile "$profile" --non-interactive --path "$artifact"
    ;;
  android)
    artifact="./build-$profile.aab"
    # Local Gradle builds need the SDK; default to Android Studio's install path.
    ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}" \
      pnpm eas build -p android --profile "$profile" --local --non-interactive --output "$artifact"
    pnpm eas submit -p android --profile "$profile" --non-interactive --path "$artifact"
    ;;
  *)
    echo "unknown platform: $platform" >&2
    exit 1
    ;;
esac
