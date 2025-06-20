import { useEffect, useState } from 'react';

export const useCancelButtonDelay = (
  isLoading: boolean,
  cancellable: boolean,
  isCancelling: boolean
) => {
  const [showCancelButton, setShowCancelButton] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (isLoading && cancellable && !isCancelling) {
      timer = setTimeout(() => {
        setShowCancelButton(true);
      }, 2000);
    } else {
      setShowCancelButton(false);
    }

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [isLoading, cancellable, isCancelling]);

  return showCancelButton;
};
