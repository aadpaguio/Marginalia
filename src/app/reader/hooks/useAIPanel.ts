import { useCallback, useState } from "react";

export interface AIPanelSelection {
  selectedText: string;
  cfi: string;
}

export function useAIPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [currentSelection, setCurrentSelection] = useState<AIPanelSelection | null>(null);

  const openPanel = useCallback((selection: AIPanelSelection) => {
    setCurrentSelection(selection);
    setIsOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    setIsOpen(false);
    setCurrentSelection(null);
  }, []);

  return {
    isOpen,
    currentSelection,
    openPanel,
    closePanel,
  };
}
