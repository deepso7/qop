import { FileRoute } from "@tanstack/react-router";
import { useStytchUser, useStytch } from "@stytch/react";

import AuthController from "@/components/auth/authController";
import { Button } from "../components/ui/button";

export const route = new FileRoute("/").createRoute({
  component: () => {
    const { user } = useStytchUser();
    const stytch = useStytch();

    if (user)
      return (
        <>
          <h1 className="text-4xl text-white">
            Logged in as {user.emails[0]?.email}
          </h1>
          <Button onClick={() => stytch.session.revoke()}>Logout</Button>
        </>
      );

    return <AuthController />;
  },
});
