import { Inter } from "next/font/google";
import { cn } from "@/utils/cn";
import dynamic from "next/dynamic";

const Lobby = dynamic(() => import("@/components/Lobby"), { ssr: false });

const inter = Inter({ subsets: ["latin"] });

export default function Home() {
  return (
    <main className={cn(inter.className, "min-h-screen w-full bg-slate-300")}>
      <div>Hello from RSC</div>
      <Lobby />
    </main>
  );
}
