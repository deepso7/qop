"use client";

import { useEffect } from "react";

import { useHuddle01 } from "@huddle01/react";

export default function Huddle01Provider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { initialize, isInitialized } = useHuddle01();

  useEffect(() => {
    if (!isInitialized) initialize("sed");
  }, [isInitialized]);

  return <>{children}</>;
}
