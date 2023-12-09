import { Suspense, lazy } from "react";
import { FileRoute } from "@tanstack/react-router";
import { useStytchUser } from "@stytch/react";

import { Skeleton } from "@/components/ui/skeleton";
import Spinner from "@/components/spinner";

const AuthController = lazy(() => import("@/components/auth/authController"));
const UserScreen = lazy(() => import("@/screens/user"));

export const route = new FileRoute("/").createRoute({
  component: () => {
    const { user } = useStytchUser();

    if (user)
      return (
        <Suspense fallback={<Spinner />}>
          <UserScreen user={user} />
        </Suspense>
      );

    return (
      <div className="flex min-h-screen w-full items-center justify-center">
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
      </div>
    );
  },
});
