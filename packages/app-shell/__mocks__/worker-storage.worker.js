// Mock worker file for tests
self.onmessage = (e) => {
  // Mock worker responses
  self.postMessage({
    id: e.data.id,
    result: null,
    type: 'success',
  });
};
