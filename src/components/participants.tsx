"use client";

import { usePeers } from "@huddle01/react/hooks";

import PeerVideo from "./peerVideo";

export default function Participants() {
  const { peers } = usePeers();

  console.log({ peers });

  return (
    <>
      {Object.values(peers).map((p) => {
        <PeerVideo key={p.peerId} peer={p} />;
      })}
    </>
  );
}
