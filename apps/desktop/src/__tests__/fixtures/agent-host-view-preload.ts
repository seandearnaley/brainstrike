import { ipcRenderer } from 'electron';

// Sandboxed preload transfers a capability; it imports no host/runtime library.
ipcRenderer.on('agent-host/connect', (event, record: unknown) => {
  window.postMessage({ record, type: 'agent-host/port' }, '*', event.ports);
});
ipcRenderer.on('agent-host/disconnected', () => {
  window.postMessage({ type: 'agent-host/disconnected' }, '*');
});
