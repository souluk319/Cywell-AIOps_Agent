import * as React from "react";

type CASContextProviderProps = {
  children?: React.ReactNode;
  value?: unknown;
};

export default function CASContextProvider({ children }: CASContextProviderProps) {
  return <>{children}</>;
}
