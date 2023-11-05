import { lazy, useState } from "react";

import LoginForm from "./loginForm";

const PasscodeForm = lazy(() => import("./passcodeForm"));

const AuthController = () => {
  const [loginState, setLoginState] = useState<"email" | "passcode">("email");
  const [user, setUser] = useState({
    email: "",
    methodId: "",
  });

  const states = {
    email: (
      <LoginForm
        changeState={(data: { email: string; methodId: string }) => {
          setUser(data);
          setLoginState("passcode");
        }}
      />
    ),
    passcode: (
      <PasscodeForm
        email={user.email}
        methodId={user.methodId}
        reset={() => setLoginState("passcode")}
      />
    ),
  } as const;

  return states[loginState];
};

export default AuthController;
