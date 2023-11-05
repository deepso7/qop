import { Suspense, lazy } from "react";
import { FileRoute } from "@tanstack/react-router";
import { useStytchUser, useStytch } from "@stytch/react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const AuthController = lazy(() => import("@/components/auth/authController"));

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

    return (
      <Suspense
        fallback={
          <div className="space-y-4">
            <Skeleton className="h-20 w-[250px]" />
            <Skeleton className="h-8 w-1/3" />
          </div>
        }
      >
        <AuthController />
      </Suspense>
    );
  },
});
