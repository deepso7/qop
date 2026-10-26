import { defineComponents } from "blume";

export default defineComponents({
  // The landing page's building blocks, used by docs/index.mdx.
  mdx: {
    Sections: "./components/landing/sections.astro",
    TideHero: "./components/landing/tide-hero.astro",
  },
  // One header for the whole site: the landing page and every docs page.
  layout: {
    Header: "./components/site-header.astro",
  },
});
