declare module "react-dom/client" {
  import * as React from "react";

  export type Root = {
    render(children: React.ReactNode): void;
    unmount(): void;
  };

  export function createRoot(container: Element | DocumentFragment): Root;
}
