import { FileRoute } from "@tanstack/react-router";

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/auth";
import Spinner from "@/components/spinner";
import AuthController from "@/components/auth/authController";
import { Button } from "../components/ui/button";

export const route = new FileRoute("/").createRoute({
  component: () => {
    const hanko = useAuth();
    const user = useQuery({
      queryKey: ["user"],
      queryFn: async () => {
        const user = await hanko.user.getCurrent();

        return user;
      },
      retry: false,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: false,
      retryOnMount: false,
      refetchIntervalInBackground: false,
    });

    if (user.isLoading) return <Spinner />;

    if (user.data)
      return (
        <>
          <h1 className="text-4xl text-white">
            Logged in as {user.data.email}
          </h1>
          <Button onClick={() => hanko.user.logout()}>Logout</Button>
        </>
      );

    return (
      <>
        <AuthController />

        {/* <div className="p-4">
          
          <Button
            onClick={async () => {
              // const wa = WebauthnSupport.supported();
              // setSupported(wa);
              // const user = await hanko.user.create("deeepso77@gmail.com");
              // const passCode = await hanko.passcode.initialize(user.user_id);
              // const auth = await hanko.passcode.finalize()
              // .then((u) => {
              //   console.log(u);
              // })
              // .catch((e) => {
              //   if (e instanceof WebauthnRequestCancelledError) {
              //     console.log("user cancelled modal");
              //     // The WebAuthn API failed. Usually in this case the user cancelled the WebAuthn dialog.
              //   } else if (e instanceof UnauthorizedError) {
              //     console.log("unauthorized error");
              //     // The user needs to login to perform this action.
              //   }
              // });
            }}
          />
        </div> */}
      </>
    );
  },
});
