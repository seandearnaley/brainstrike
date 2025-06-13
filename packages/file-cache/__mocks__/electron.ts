// Mock for Electron API during testing
export const app = {
  getPath: (name: string) => {
    if (name === 'userData') {
      return '/tmp/test-userdata';
    }
    return '/tmp';
  },
  whenReady: () => Promise.resolve(),
};

export const dialog = {
  showOpenDialog: async () => ({
    canceled: false,
    filePaths: ['/tmp/test-directory'],
  }),
};

export default {
  app,
  dialog,
};