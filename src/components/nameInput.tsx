import { useRoom } from "@huddle01/react/hooks";

import { useSetName } from "../atoms";
import { useToast } from "../hooks/use-toast";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export default function NameInput() {
  const setName = useSetName();
  const { toast, dismiss } = useToast();

  const { joinRoom, isLoading, isRoomJoined, error } = useRoom();

  return (
    <form
      className="flex items-center justify-center gap-4"
      onSubmit={() => {
        if (error) {
          toast({ description: `error joining room, error: ${error}` });
          setTimeout(() => dismiss(), 3000);
          return;
        }

        if (isRoomJoined) {
          toast({ description: "Room already joined" });
          setTimeout(() => dismiss(), 3000);
          return;
        }

        if (isLoading) {
          toast({ description: "Please wait while we join the room" });
          setTimeout(() => dismiss(), 3000);
          return;
        }

        joinRoom();
      }}
    >
      <Input
        placeholder="Name"
        className="w-2/3 border-black"
        type="text"
        onChange={(e) => setName(e.target.value)}
      />
      <Button type="submit">&#10132;</Button>
    </form>
  );
}
