import { FileRoute } from "@tanstack/react-router";
import { Input } from "@/components/ui/input";

export const route = new FileRoute("/").createRoute({
  component: () => {
    return (
      <>
        <div className="p-4">
          <Input />
        </div>
      </>
    );
  },
});
