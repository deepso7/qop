import type { ReactNode } from "react";

// iOS rows are styled with settingsSectionModifiers; Android supplies a palette.
export const SettingsPalette = ({ children }: { children: ReactNode }) =>
  children;
