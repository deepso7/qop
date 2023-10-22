import { FileRoute } from "@tanstack/react-router";

export const route = new FileRoute("/about").createRoute({
  component: () => {
    return (
      <div className="p-2">
        <h3>HUEHUEHUEHUEHUHUE</h3>
      </div>
    );
  },
});
