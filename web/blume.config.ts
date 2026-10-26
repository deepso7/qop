import { defineConfig } from "blume";
import { cloudflare } from "blume/deploy";

export default defineConfig({
  title: "qop",
  deployment: cloudflare({
    site: "https://qop.sh",
  }),
  description: "Peer-to-peer messaging with nothing in the middle.",
  // The pixel wordmark, in currentColor so it follows the theme.
  logo: { image: "/logo.svg", text: "" },
  // Privacy lives in the footer, not the header.
  footer: {
    links: [{ label: "Privacy", href: "/privacy" }],
  },
  // Colours and the dark theme live in theme.css; these set the accent for
  // generated assets (OG cards) and the fonts.
  theme: {
    accent: { light: "oklch(0.5 0.11 45)", dark: "oklch(0.74 0.12 50)" },
    radius: "sm",
    fonts: {
      // Paper Mono (OFL, fonts/PaperMono-OFL.txt), self-hosted as a variable font.
      display: {
        name: "Paper Mono",
        variants: [{ src: "./fonts/PaperMono.woff2" }],
      },
      mono: {
        name: "Paper Mono",
        variants: [{ src: "./fonts/PaperMono.woff2" }],
      },
    },
  },
});
