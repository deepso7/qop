import React, { Suspense } from "react";
import { Outlet, RootRoute } from "@tanstack/react-router";

const TanStackRouterDevtools =
  process.env.NODE_ENV === "production"
    ? () => null // Render nothing in production
    : React.lazy(() =>
        // Lazy load in development
        import("@tanstack/router-devtools").then((res) => ({
          default: res.TanStackRouterDevtools,
          // For Embedded Mode
          // default: res.TanStackRouterDevtoolsPanel
        }))
      );

export const route = new RootRoute({
  component: () => (
    <>
      {/* <div className="p-2 flex gap-2 text-lg">
        <Link
          to="/"
          activeProps={{
            className: "font-bold",
          }}
          activeOptions={{ exact: true }}
        >
          Home
        </Link>{" "}
        <Link
          to={"/about"}
          activeProps={{
            className: "font-bold",
          }}
        >
          About
        </Link>{" "}
        <Link
          to="/tauri"
          activeProps={{
            className: "font-bold",
          }}
        >
          Tauri
        </Link>
      </div>
      <hr /> */}
      <div className="min-h-screen overflow-y-hidden">
        <Outlet />
      </div>
      {/* Start rendering router matches */}
      <Suspense>
        <TanStackRouterDevtools initialIsOpen={false} position="bottom-left" />
      </Suspense>
    </>
  ),
});
