import "./styles.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, Router } from "@tanstack/react-router";
import { ThemeProvider } from "@/components/theme-provider";

import { routeTree } from "./routeTree.gen";
import AuthProvider from "./auth/AuthProvider";

const router = new Router({
  routeTree,
  defaultPreload: "intent",
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ThemeProvider>
  </React.StrictMode>
);

// Register things for typesafety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
