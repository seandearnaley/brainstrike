import { addLogListener, LogBuffer } from '@brainstrike/utils';

const webLogBuffer = new LogBuffer({ size: 1000 });
const removeListener = addLogListener((record) => {
  webLogBuffer.push(record);
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    removeListener();
  });
}

export function getWebLogBuffer(): LogBuffer {
  return webLogBuffer;
}
