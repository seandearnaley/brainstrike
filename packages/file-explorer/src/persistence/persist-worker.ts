self.onmessage = (e: MessageEvent<{ name: string; value?: unknown; type: 'set' | 'remove' }>) => {
  const { name, value, type } = e.data;
  try {
    if (type === 'set') {
      const serialized = JSON.stringify(value);
      localStorage.setItem(name, serialized);
    } else if (type === 'remove') {
      localStorage.removeItem(name);
    }
  } catch {
    // ignore errors
  }
};
export {};
