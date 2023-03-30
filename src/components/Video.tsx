"use client";

import { useEffect, useRef } from "react";

import { useVideo } from "@huddle01/react/hooks";

import { AspectRatio } from "./ui/aspect-ratio";

export default function Video() {
  const { fetchVideoStream, isLoading, error, stopVideoStream, stream } =
    useVideo();

  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!isLoading && !stream) fetchVideoStream();

    if (stream && ref.current) {
      ref.current.srcObject = stream;
    }
  }, [isLoading, stream, ref.current]);

  if (error) return <div>Error fetching video</div>;

  return (
    <div className="w-96">
      <AspectRatio
        ratio={4 / 3}
        className="flex justify-center items-center animate-opacity-show z-20 h-full w-full rounded-lg border border-orange-600"
      >
        {isLoading ? (
          <div className="animate-pulse bg-orange-300 w-full h-full"></div>
        ) : (
          <video ref={ref} autoPlay muted className="-scale-x-100 rounded-lg" />
        )}
      </AspectRatio>
    </div>
  );
}
