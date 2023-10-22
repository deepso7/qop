import { FileRoute } from "@tanstack/react-router";

export const route = new FileRoute("/").createRoute({
  component: () => {
    return (
      <>
        <div>lol</div>
      </>
    );
  },
});
