import { addLogListener, LogBuffer } from '@brainstrike/utils';

const rendererLogBuffer = new LogBuffer({ size: 1000 });
const removeListener = addLogListener((record) => {
  rendererLogBuffer.push(record);
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    removeListener();
  });
}

export function getRendererLogBuffer(): LogBuffer {
  return rendererLogBuffer;
}
