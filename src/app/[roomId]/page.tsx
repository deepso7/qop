import dynamic from "next/dynamic";

const Lobby = dynamic(() => import("@/components/Lobby"), { ssr: false });

export default function Page() {
  return (
    <>
      <div>Lobby</div>;
      <Lobby />
    </>
  );
}
