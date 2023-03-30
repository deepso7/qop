"use client";

import { useEffect } from "react";

import { useHuddle01, useLobby } from "@huddle01/react/hooks";
import { usePathname, useRouter } from "next/navigation";

import Video from "./video";

const Lobby = () => {
  const { joinLobby, isLoading, isLobbyJoined, error } = useLobby();
  const { isInitialized } = useHuddle01();

  const path = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!isInitialized) return;

    if (!isLoading && !isLobbyJoined) {
      const roomId = path?.split("/")[1];

      if (!roomId) {
        router.push("/404");
        return;
      }

      joinLobby("qhy-moov-uwp");
    }
  }, [isInitialized, isLobbyJoined]);

  if (isLoading || !isInitialized) return <div>Loading...</div>;
  if (error) return <div>Error</div>;

  return (
    <div className="flex justify-center flex-col items-center gap-4">
      <div>lobby</div>
      <Video />
    </div>
  );
};

export default Lobby;
