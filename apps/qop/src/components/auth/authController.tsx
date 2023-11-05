import { useState } from "react";
import LoginForm from "./loginForm";
import PasscodeForm from "./passcodeForm";

const AuthController = () => {
  const [loginState, setLoginState] = useState<"email" | "passcode">("email");
  const [user, setUser] = useState<{ email: string; userId: string }>({
    email: "",
    userId: "",
  });

  const states = {
    email: (
      <LoginForm
        changeState={(data: { email: string; userId: string }) => {
          setUser(data);
          setLoginState("passcode");
        }}
      />
    ),
    passcode: <PasscodeForm email={user.email} userId={user.userId} />,
  } as const;

  return states[loginState];
};

export default AuthController;
