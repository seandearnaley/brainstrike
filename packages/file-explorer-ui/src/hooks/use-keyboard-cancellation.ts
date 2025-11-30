import { useEffect } from 'react';

export const useKeyboardCancellation = (
  isLoading: boolean,
  cancellable: boolean,
  isCancelling: boolean,
  onCancel?: () => void
) => {
  useEffect(() => {
    if (!(isLoading && cancellable) || isCancelling || !onCancel) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isLoading, cancellable, onCancel, isCancelling]);
};
