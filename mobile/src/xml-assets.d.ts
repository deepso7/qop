// Android vector drawables (e.g. header menu icons) bundled as image assets.
declare module "*.xml" {
  import type { ImageSourcePropType } from "react-native";

  const source: ImageSourcePropType;
  export default source;
}
