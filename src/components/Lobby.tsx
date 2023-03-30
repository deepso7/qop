"use client";

import { useEffect } from "react";

import { useHuddle01, useLobby } from "@huddle01/react/hooks";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";

const Video = dynamic(() => import("./video"), { ssr: false });

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitialized, isLobbyJoined]);

  if (isLoading || !isInitialized || !isLobbyJoined)
    return <div>Loading...</div>;
  if (error) return <div>Error</div>;

  return (
    <div className="flex flex-col items-center justify-center gap-4">
      <div>lobby</div>
      <Video />
    </div>
  );
};

export default Lobby;
