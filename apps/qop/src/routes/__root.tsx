import { Outlet, RootRoute } from "@tanstack/react-router";
// import { TanStackRouterDevtools } from "@tanstack/router-devtools";

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
      <div className="flex min-h-screen w-full items-center justify-center">
        <Outlet />
      </div>
      {/* Start rendering router matches */}
      {/* <TanStackRouterDevtools position="bottom-right" /> */}
    </>
  ),
});
