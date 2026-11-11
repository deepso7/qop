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
  // Home, the docs and privacy share one sidebar of our own
  // (components/docs/sidebar.astro), with the header and footer
  // (components/site-*.astro). Home lives at /, as on executor.sh; /home is an
  // alias for it.
  redirects: [{ from: "/home", to: "/" }],
  // External links in pages open in a new tab, like the sidebar's and footer's.
  markdown: { externalLinks: true },
  // qop has no analytics, so Blume's "Was this page helpful?" would record nothing.
  feedback: false,
  // Colours and the dark theme live in theme.css; these set the accent for
  // generated assets (OG cards), the corner radius and the fonts.
  theme: {
    accent: { light: "oklch(0.5 0.11 45)", dark: "oklch(0.74 0.12 50)" },
    // Soft corners on docs cards, code blocks and callouts, matching the panels.
    radius: "lg",
    fonts: {
      // Paper Mono (OFL, fonts/PaperMono-OFL.txt), self-hosted as a variable font.
      display: {
        name: "Paper Mono",
        variants: [{ src: "./fonts/PaperMono.woff2" }],
      },
      body: {
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
