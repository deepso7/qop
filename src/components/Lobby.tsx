"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "./ui/button";
import { Input } from "./ui/input";

const Lobby = () => {
  const [roomId, setRoomId] = useState("");
  const [input, setInput] = useState(false);
  const router = useRouter();

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
          <Button className="" onClick={() => router.push(`/${roomId}`)}>
            &#10132;
          </Button>
        </>
      ) : (
        <>
          <Button
            className="w-1/2 bg-orange-300 hover:bg-orange-500"
            variant="subtle"
            onClick={() => setInput(true)}
          >
            Enter
          </Button>
          <Button
            className="w-1/2 bg-orange-300 hover:bg-orange-500"
            variant="subtle"
            onClick={() => alert("Not implemented yet")}
          >
            Create Room
          </Button>
        </>
      )}
    </div>
  );
};

export default Lobby;
