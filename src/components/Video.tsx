"use client";

import { useEffect, useRef } from "react";

import { useAudio, useVideo } from "@huddle01/react/hooks";
import { Camera, CameraOff, Mic, MicOff } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

import { useCamState, useMicState, useNameState } from "../atoms";
import { AspectRatio } from "./ui/aspect-ratio";
import { Button } from "./ui/button";

export default function Video() {
  const [mic, setMic] = useMicState();
  const [camera, setCamera] = useCamState();
  const [name] = useNameState();

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { fetchVideoStream, isLoading, error, stopVideoStream, stream } =
    useVideo();
  const { fetchAudioStream } = useAudio();

  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!isLoading && !stream) {
      fetchVideoStream();
      fetchAudioStream();
    }

    if (stream && ref.current) {
      ref.current.srcObject = stream as MediaStream;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, stream, ref.current]);

  if (error) return <div>Error fetching video</div>;

  return (
    <div className="flex flex-col items-center justify-center gap-4">
      <div className="w-96">
        <AspectRatio
          ratio={4 / 3}
          className="z-20 flex h-full w-full items-center justify-center rounded-lg border border-orange-600"
        >
          {isLoading ? (
            <div className="h-full w-full animate-pulse bg-orange-300"></div>
          ) : !camera ? (
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
      <div className="flex items-center justify-center gap-4">
        <Button
          onClick={() => {
            setCamera((prev) => !prev);

            if (camera) stopVideoStream();
            else fetchVideoStream();
          }}
        >
          {camera ? <Camera /> : <CameraOff />}
        </Button>
        <Button onClick={() => setMic((prev) => !prev)}>
          {mic ? <Mic /> : <MicOff />}
        </Button>
      </div>
    </div>
  );
}
