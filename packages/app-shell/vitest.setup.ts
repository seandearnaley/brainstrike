// Import shared test utilities setup
import '@brainstrike/test-utils/vitest.setup';
import { beforeEach } from 'vitest';
import { resetAppShellSessionStores } from './src/reset-app-shell-session-stores';

beforeEach(() => {
  resetAppShellSessionStores();
});

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window !== 'undefined') {
  const windowEnvironment = window as typeof window & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  windowEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
}
