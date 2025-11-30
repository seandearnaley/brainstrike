// Operation handlers for different storage operations
type StorageOperation = {
  id: string;
  type: string;
  key?: string;
  value?: unknown;
  operation?: string;
  rawValue?: string;
  success?: boolean;
};

// Handle save operation
function handleSaveOperation(data: StorageOperation): void {
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
function handleLoadOperation(data: StorageOperation): void {
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
function handleRemoveOperation(data: StorageOperation): void {
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
function handleStorageResponse(data: StorageOperation): void {
  const result = data.operation === 'getItem' && data.rawValue ? JSON.parse(data.rawValue) : true;

  self.postMessage({
    id: data.id,
    type: 'success',
    result,
  });
}

// Main event handler
self.addEventListener('message', async (event) => {
  const data = event.data as StorageOperation;

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
