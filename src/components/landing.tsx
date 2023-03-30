"use client";

import { useState } from "react";

import { useLobby } from "@huddle01/react/hooks";
import { useRouter } from "next/navigation";

import { useToast } from "@/hooks/use-toast";

import { Button } from "./ui/button";
import { Input } from "./ui/input";

const Landing = () => {
  const [roomId, setRoomId] = useState("");
  const [input, setInput] = useState(false);
  const { joinLobby } = useLobby();

  const router = useRouter();
  const { toast, dismiss } = useToast();

  return (
    <>
      {input ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!roomId) return toast({ description: "Room Id is required" });
            joinLobby(roomId);
            router.push(`/${roomId}`);
          }}
          className="mt-4 flex justify-center gap-4 px-4"
        >
          <Input
            placeholder="Room Id"
            className="w-2/3 border-black focus:ring-orange-400"
            type="text"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          />
          <Button className="" type="submit">
            &#10132;
          </Button>
        </form>
      ) : (
        <div className="mt-4 flex justify-center gap-4 px-4">
          <Button
            className="w-1/2 bg-orange-300 hover:bg-orange-500 active:translate-y-[1px]"
            variant="subtle"
            onClick={() => {
              dismiss();
              setInput(true);
            }}
          >
            Enter
          </Button>
          <Button
            className="w-1/2 bg-orange-300 hover:bg-orange-500 active:translate-y-[1px]"
            variant="subtle"
            onClick={() => toast({ description: "Not implemented yet" })}
          >
            Create Room
          </Button>
        </div>
      )}
    </>
  );
};

export default Landing;
