import { defineComponents } from "blume";

export default defineComponents({
  // Home's demos, used by docs/index.mdx.
  mdx: {
    ChatScene: "./components/home/chat-scene.astro",
    Diorama: "./components/home/diorama.astro",
  },
  // One header, footer and sidebar layout for the whole site (components/docs
  // holds the sidebar, contents list and page links).
  layout: {
    Header: "./components/site-header.astro",
    Footer: "./components/site-footer.astro",
    Sidebar: "./components/docs/sidebar.astro",
    TableOfContents: "./components/docs/toc.astro",
    Pagination: "./components/docs/pagination.astro",
    Breadcrumbs: "./components/docs/breadcrumbs.astro",
  },
});
