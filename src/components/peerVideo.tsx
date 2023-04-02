"use client";

import { useEffect, useRef } from "react";

import { AspectRatio } from "./ui/aspect-ratio";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";

interface Props {
  peer: {
    peerId: string;
    isHost: boolean;
    isCoHost: boolean;
    mic: MediaStreamTrack | null;
    cam: MediaStreamTrack | null;
  };
}

const name = "sed";

export default function PeerVideo({ peer }: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  console.log("lemaoooooooooooo");

  const getStream = (track: MediaStreamTrack) => {
    const stream = new MediaStream();
    stream.addTrack(track);
    return stream;
  };

  useEffect(() => {
    if (peer.cam && ref.current) {
      ref.current.srcObject = getStream(peer.cam);
    }
  }, [peer.cam]);

  return (
    <div className="flex flex-col items-center justify-center gap-4">
      <div className="w-96">
        <AspectRatio
          ratio={4 / 3}
          className="z-20 flex h-full w-full items-center justify-center rounded-lg border border-orange-600"
        >
          {!peer.cam ? (
            <Avatar className="h-32 w-32 object-contain">
              <AvatarImage
                src={`https://api.dicebear.com/6.x/pixel-art/svg?seed=${name}`}
                alt="avatar"
              />
              <AvatarFallback className="text-3xl uppercase">{`${
                name[0] || "N"
              }${name[1] || "A"}`}</AvatarFallback>
            </Avatar>
          ) : (
            <video
              ref={ref}
              autoPlay
              muted
              className="-scale-x-100 rounded-lg"
            />
          )}
        </AspectRatio>
      </div>
    </div>
  );
}
