"use client";

import { useEventListener } from "@huddle01/react";
import { useAudio, useVideo } from "@huddle01/react/hooks";
import { Camera, CameraOff, Mic, MicOff } from "lucide-react";

import { useCamState, useMicState } from "../atoms";
import { Button } from "./ui/button";

export default function BtmBar() {
  const [camera, setCamera] = useCamState();
  const [mic, setMic] = useMicState();

  const {
    fetchVideoStream,
    stopVideoStream,
    produceVideo,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    stream: videoStream,
  } = useVideo();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { produceAudio, stream: audioStream } = useAudio();

  useEventListener("room:joined", () => {
    console.log("JOINEDEDEDEDEDE");

    if (mic) produceAudio(audioStream);
    if (camera) produceVideo(videoStream);
  });

  return (
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
  );
}
