import { Hanko } from "@teamhanko/hanko-frontend-sdk";
import { createContext, useContext } from "react";
import { env } from "../env";

const AuthContext = createContext<Hanko | undefined>(undefined);

const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  return (
    <AuthContext.Provider value={new Hanko(env.VITE_HANKO_API_URL)}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const hanko = useContext(AuthContext);

  if (!hanko) throw new Error("useAuth must be used within an AuthProvider");

  return hanko;
};

export default AuthProvider;
