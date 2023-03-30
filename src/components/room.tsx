"use client";

import { useRoom } from "@huddle01/react/hooks";

import Lobby from "./lobby";

export default function Room() {
  const { isRoomJoined } = useRoom();

  if (isRoomJoined) return <Lobby />;
}
