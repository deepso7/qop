"use client";

import { useEffect, useRef, useState } from "react";

import { useAudio, useVideo } from "@huddle01/react/hooks";
import { ArrowBigRight, Camera, CameraOff, Mic, MicOff } from "lucide-react";

import { AspectRatio } from "./ui/aspect-ratio";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export default function Video() {
  const [mic, setMic] = useState(true);
  const [camera, setCamera] = useState(true);

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
      ref.current.srcObject = stream;
    }
  }, [isLoading, stream, ref.current]);

  if (error) return <div>Error fetching video</div>;

  return (
    <div className="flex flex-col justify-center items-center gap-4">
      <div className="w-96">
        <AspectRatio
          ratio={4 / 3}
          className="flex justify-center items-center animate-opacity-show z-20 h-full w-full rounded-lg border border-orange-600"
        >
          {isLoading ? (
            <div className="animate-pulse bg-orange-300 w-full h-full"></div>
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
      <div className="flex justify-center items-center gap-4">
        <Button onClick={() => setCamera((prev) => !prev)}>
          {camera ? <Camera /> : <CameraOff />}
        </Button>
        <Button onClick={() => setMic((prev) => !prev)}>
          {mic ? <Mic /> : <MicOff />}
        </Button>
      </div>

      <div className="flex justify-center items-center gap-4">
        <Input placeholder="Name" className="w-2/3 border-black" type="text" />
        <Button className="">&#10132;</Button>
      </div>
    </div>
  );
}
