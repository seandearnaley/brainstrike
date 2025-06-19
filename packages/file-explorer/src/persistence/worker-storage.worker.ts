self.addEventListener('message', async (event) => {
  const { id, type, key, value } = event.data;
  try {
    let result: unknown;
    switch (type) {
      case 'save': {
        if (!key || value === undefined) {
          throw new Error('Save operation requires key and value');
        }
        // Avoid double-stringifying if the value is already a string
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        const opId = Date.now();
        self.postMessage({
          id,
          type: 'storage_request',
          operation: 'setItem',
          key,
          value: serialized,
          opId,
        });
        return;
      }
      case 'load': {
        if (!key) {
          throw new Error('Load operation requires key');
        }
        self.postMessage({
          id,
          type: 'storage_request',
          operation: 'getItem',
          key,
        });
        return;
      }
      case 'remove': {
        if (!key) {
          throw new Error('Remove operation requires key');
        }
        self.postMessage({
          id,
          type: 'storage_request',
          operation: 'removeItem',
          key,
        });
        return;
      }
      case 'storage_response': {
        if (event.data.operation === 'getItem' && event.data.rawValue) {
          result = JSON.parse(event.data.rawValue);
        } else {
          result = event.data.success || true;
        }
        self.postMessage({ id, type: 'success', result });
        break;
      }
      default:
        throw new Error(`Unknown operation type: ${type}`);
    }
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export {};
