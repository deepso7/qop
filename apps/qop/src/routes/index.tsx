import { FileRoute } from "@tanstack/react-router";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/auth";
import {
  UnauthorizedError,
  WebauthnRequestCancelledError,
  WebauthnSupport,
} from "@teamhanko/hanko-frontend-sdk";
import { Button } from "../components/ui/button";

export const route = new FileRoute("/").createRoute({
  component: () => {
    const hanko = useAuth();

    return (
      <>
        <div className="p-4">
          <h1 className="text-2xl text-white">lol</h1>
          <Input />
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
        </div>
      </>
    );
  },
});
