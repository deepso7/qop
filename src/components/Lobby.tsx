"use client";

import { useHuddle01Web } from "@huddle01/react/hooks";
import { useEffect } from "react";

const Lobby = () => {
  const { state, send } = useHuddle01Web();

  useEffect(() => {
    send("INIT");
  }, [send]);

  return <div>{JSON.stringify(state)}</div>;
};

export default Lobby;
