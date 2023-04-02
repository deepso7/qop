"use client";

import { useRoom } from "@huddle01/react/hooks";
import dynamic from "next/dynamic";

const Lobby = dynamic(() => import("./lobby"), { ssr: false });
const Viewport = dynamic(() => import("./viewport"), { ssr: false });
const BtmBar = dynamic(() => import("./btmBar"), { ssr: false });

export default function Room() {
  const { isRoomJoined, error, isLoading } = useRoom();

  console.log({ isRoomJoined, error, isLoading });

  if (!isRoomJoined) return <Lobby />;
  if (error) return <div>Error in room {error}</div>;
  if (isLoading) return <div>Loadin room...</div>;

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center overflow-hidden">
      <div className="h-screen w-screen overflow-hidden p-4">
        <Viewport />
      </div>
      <div className="w-full max-w-full pb-4">
        <BtmBar />
      </div>
    </div>
  );
}
