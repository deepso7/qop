import { StytchProvider } from "@stytch/react";
import { StytchHeadlessClient } from "@stytch/vanilla-js/headless";

import { env } from "../env";

const stytchClient = new StytchHeadlessClient(env.VITE_STYTCH_PUBLIC_TOKEN);

const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  return <StytchProvider stytch={stytchClient}>{children}</StytchProvider>;
};

export default AuthProvider;
