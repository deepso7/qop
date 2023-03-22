"use client";

import { useEffect } from "react";
import { useEventListener } from "@huddle01/react";
import { useHuddle01Web } from "@huddle01/react/hooks";

const Lobby = () => {
  const { state, send } = useHuddle01Web();

  useEffect(() => {
    send("INIT");
  }, [send]);

  useEventListener(state, "Initialized", () => {
    console.log("Initialized");
    send({ type: "JOIN_LOBBY", roomId: "test" });
  });

  return (
    <>
      <div>Lobby</div>
    </>
  );
};

export default Lobby;
