import { defineConfig } from "blume";
import { cloudflare } from "blume/deploy";

export default defineConfig({
  title: "QOP",
  deployment: cloudflare({
    site: "https://qop.sh",
  }),
  description: "Documentation powered by Blume.",
});
