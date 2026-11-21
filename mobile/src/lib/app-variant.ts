import Constants from "expo-constants";

export const isDevelopmentVariant =
  Constants.expoConfig?.extra?.appVariant === "development";
