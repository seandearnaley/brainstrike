import { addLogListener, LogBuffer } from '@brainstrike/utils';

const rendererLogBuffer = new LogBuffer({ size: 1000 });
const removeListener = addLogListener((record) => {
  rendererLogBuffer.push(record);
});

if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__brainstrikeRendererLogBuffer', {
    value: rendererLogBuffer,
    configurable: true,
    writable: false,
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    removeListener();
  });
}

export function getRendererLogBuffer(): LogBuffer {
  return rendererLogBuffer;
}
