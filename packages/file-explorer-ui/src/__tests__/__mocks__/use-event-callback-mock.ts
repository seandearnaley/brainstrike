export const useEventCallbackMock = <T extends (...args: never[]) => unknown>(callback: T): T =>
  callback;
