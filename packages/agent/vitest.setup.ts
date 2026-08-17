import { configureLogger } from '@brainstrike/logging';
import { beforeEach } from 'vitest';

beforeEach(() => {
  configureLogger({ console: false });
});
