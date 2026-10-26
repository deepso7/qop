import { defineConfig } from "blume";
import { cloudflare } from "blume/deploy";

export default defineConfig({
  title: "QOP",
  deployment: cloudflare({
    site: "https://qop.sh",
  }),
  description: "Documentation powered by Blume.",
  theme: {
    fonts: {
      // Paper Mono (OFL, fonts/PaperMono-OFL.txt), self-hosted as a variable font.
      mono: { name: "Paper Mono", variants: [{ src: "./fonts/PaperMono.woff2" }] },
    },
  },
});
