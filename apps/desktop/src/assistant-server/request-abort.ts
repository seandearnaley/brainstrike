import type http from 'node:http';

export function registerRequestAbort(
  req: http.IncomingMessage,
  res: http.ServerResponse
): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const abortController = new AbortController();
  const onAbort = () => {
    abortController.abort();
  };
  const onRequestClose = () => {
    if (!req.complete) {
      onAbort();
    }
  };
  const onResponseClose = () => {
    if (!res.writableEnded) {
      onAbort();
    }
  };

  req.on('close', onRequestClose);
  res.on('close', onResponseClose);

  return {
    cleanup: () => {
      req.removeListener('close', onRequestClose);
      res.removeListener('close', onResponseClose);
    },
    signal: abortController.signal,
  };
}
