import { defineComponents } from "blume";

export default defineComponents({
  // The landing page's building blocks, used by docs/index.mdx.
  mdx: {
    Sections: "./components/landing/sections.astro",
    Hero: "./components/landing/hero.astro",
    // PROTOTYPE (throwaway): zriz-style docs, components/prototype-docs-intro.
    PrototypeDemo: "./components/prototype-docs-intro/demo.astro",
  },
  // One header and footer for the whole site: the landing page and every docs page.
  layout: {
    Header: "./components/site-header.astro",
    Footer: "./components/site-footer.astro",
    // PROTOTYPE (throwaway): zriz-style docs shell.
    Sidebar: "./components/prototype-docs-intro/sidebar.astro",
    TableOfContents: "./components/prototype-docs-intro/toc.astro",
    Pagination: "./components/prototype-docs-intro/pagination.astro",
  },
});
