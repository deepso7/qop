"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/hooks/use-toast";

import { Button } from "./ui/button";
import { Input } from "./ui/input";

const Landing = () => {
  const [roomId, setRoomId] = useState("");
  const [input, setInput] = useState(false);

  const router = useRouter();
  const { toast, dismiss } = useToast();

  return (
    <div className="mt-4 flex gap-4">
      {input ? (
        <>
          <Input
            placeholder="Room Id"
            className="w-2/3 border-black focus:ring-orange-400"
            type="text"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          />
          <Button
            className=""
            onClick={() => {
              if (!roomId) return toast({ description: "Room Id is required" });

              router.push(`/${roomId}`);
            }}
          >
            &#10132;
          </Button>
        </>
      ) : (
        <>
          <Button
            className="w-1/2 bg-orange-300 hover:bg-orange-500"
            variant="subtle"
            onClick={() => {
              dismiss();
              setInput(true);
            }}
          >
            Enter
          </Button>
          <Button
            className="w-1/2 bg-orange-300 hover:bg-orange-500"
            variant="subtle"
            onClick={() => toast({ description: "Not implemented yet" })}
          >
            Create Room
          </Button>
        </>
      )}
    </div>
  );
};

export default Landing;
