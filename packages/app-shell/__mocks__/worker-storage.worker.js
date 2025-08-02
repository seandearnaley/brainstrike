// Mock worker file for tests
self.onmessage = function(e) {
  // Mock worker responses
  self.postMessage({
    id: e.data.id,
    type: 'success',
    result: null
  });
};