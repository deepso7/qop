import { getDefaultConfig } from "expo/metro-config";
import { withUniwindConfig } from "uniwind/metro";

const config = getDefaultConfig(import.meta.dirname);

export default withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./src/uniwind-types.d.ts",
});
