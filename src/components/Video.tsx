"use client";

import { useVideo } from "@huddle01/react/hooks";

export default function Video() {
  const { fetchVideoStream, isLoading, error, stopVideoStream } = useVideo();

  return <div>Video</div>;
}
