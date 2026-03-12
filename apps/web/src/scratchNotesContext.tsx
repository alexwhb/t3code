import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { PinMessageParams } from "./scratchNotes";

interface ScratchNotesContextValue {
  openSheet: () => void;
  pinMessage: (params: PinMessageParams) => void;
}

const ScratchNotesContext = createContext<ScratchNotesContextValue | null>(null);

export function ScratchNotesProvider({
  children,
  openSheet,
  pinMessage,
}: {
  children: ReactNode;
  openSheet: () => void;
  pinMessage: (params: PinMessageParams) => void;
}) {
  const value = useMemo(() => ({ openSheet, pinMessage }), [openSheet, pinMessage]);
  return <ScratchNotesContext.Provider value={value}>{children}</ScratchNotesContext.Provider>;
}

export function useScratchNotesContext(): ScratchNotesContextValue | null {
  return useContext(ScratchNotesContext);
}
