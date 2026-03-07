// Handle save operation
function handleSaveOperation(data) {
  if (!data.key || data.value === undefined) {
    throw new Error('Save operation requires key and value');
  }

  const serialized = typeof data.value === 'string' ? data.value : JSON.stringify(data.value);
  const opId = Date.now();

  self.postMessage({
    id: data.id,
    type: 'storage_request',
    operation: 'setItem',
    key: data.key,
    value: serialized,
    opId,
  });
}

// Handle load operation
function handleLoadOperation(data) {
  if (!data.key) {
    throw new Error('Load operation requires key');
  }

  self.postMessage({
    id: data.id,
    type: 'storage_request',
    operation: 'getItem',
    key: data.key,
  });
}

// Handle remove operation
function handleRemoveOperation(data) {
  if (!data.key) {
    throw new Error('Remove operation requires key');
  }

  self.postMessage({
    id: data.id,
    type: 'storage_request',
    operation: 'removeItem',
    key: data.key,
  });
}

// Handle storage response
function handleStorageResponse(data) {
  let result = true;
  if (data.operation === 'getItem') {
    if (data.rawValue) {
      try {
        result = JSON.parse(data.rawValue);
      } catch {
        result = null;
      }
    } else {
      result = null;
    }
  }

  self.postMessage({
    id: data.id,
    type: 'success',
    result,
  });
}

self.addEventListener('message', async (event) => {
  const data = event.data;

  try {
    switch (data.type) {
      case 'save':
        handleSaveOperation(data);
        break;
      case 'load':
        handleLoadOperation(data);
        break;
      case 'remove':
        handleRemoveOperation(data);
        break;
      case 'storage_response':
        handleStorageResponse(data);
        break;
      default:
        throw new Error(`Unknown operation type: ${data.type}`);
    }
  } catch (error) {
    self.postMessage({
      id: data.id,
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export {};
