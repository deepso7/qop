import { route as rootRoute } from "./routes/__root";
import { route as AboutRoute } from "./routes/about";
import { route as IndexRoute } from "./routes/index";
import { route as TauriRoute } from "./routes/tauri";

declare module "@tanstack/react-router" {
  interface FileRoutesByPath {
    "/": {
      parentRoute: typeof rootRoute;
    };
    "/about": {
      parentRoute: typeof rootRoute;
    };
    "/tauri": {
      parentRoute: typeof rootRoute;
    };
  }
}

Object.assign(IndexRoute.options, {
  path: "/",
  getParentRoute: () => rootRoute,
});

Object.assign(AboutRoute.options, {
  path: "/about",
  getParentRoute: () => rootRoute,
});

Object.assign(TauriRoute.options, {
  path: "/tauri",
  getParentRoute: () => rootRoute,
});

export const routeTree = rootRoute.addChildren([
  IndexRoute,
  AboutRoute,
  TauriRoute,
]);
