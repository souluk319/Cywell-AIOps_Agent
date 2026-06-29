import * as React from "react";
import { CASLauncher } from "./useCASLauncher";

type CASContextProviderProps = {
  children?: React.ReactNode;
  value?: unknown;
};

export default function CASContextProvider({ children }: CASContextProviderProps) {
  return (
    <>
      {children}
      <CASLauncher />
    </>
  );
}
