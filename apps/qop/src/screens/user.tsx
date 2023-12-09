import { useMemo } from "react";
import { useStytch } from "@stytch/react";
import { User } from "@stytch/vanilla-js";
import { createAvatar } from "@dicebear/core";
import { thumbs } from "@dicebear/collection";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Props {
  user: User;
}

const UserScreen: React.FC<Props> = ({ user }) => {
  const stytch = useStytch();

  const avatar = useMemo(
    () =>
      createAvatar(thumbs, {
        seed: user.emails[0]?.email,
      }),
    [user.emails[0]?.email]
  );

  return (
    <div className="p-2 w-full">
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Avatar>
              <AvatarImage src={avatar.toDataUriSync()} />
              <AvatarFallback>{`${user.emails[0]?.email[0]}${user.emails[0]?.email[1]}`}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{user.emails[0]?.email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => stytch.session.revoke()}>
              Log out
              <DropdownMenuShortcut>bui bui</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};

export default UserScreen;
