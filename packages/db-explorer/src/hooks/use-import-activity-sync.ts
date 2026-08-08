import { useEffect } from 'react';

export function useImportActivitySync(
  isImporting: boolean,
  setIsImporting: (isImporting: boolean) => void
): void {
  useEffect(() => {
    setIsImporting(isImporting);
  }, [isImporting, setIsImporting]);
}
