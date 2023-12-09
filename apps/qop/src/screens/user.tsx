import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useStytch } from "@stytch/react";
import { User } from "@stytch/vanilla-js";

interface Props {
  user: User;
}

const UserScreen: React.FC<Props> = ({ user }) => {
  const stytch = useStytch();

  return (
    <div className="p-2 w-full">
      <div className="flex justify-end">
        <Tooltip>
          <TooltipTrigger>
            <Button onClick={() => stytch.session.revoke()}>Logout</Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>logged in as {user.emails[0]?.email}</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};

export default UserScreen;
