import { configureLogger } from '@brainstrike/utils/logger';
import { beforeEach } from 'vitest';

beforeEach(() => {
  configureLogger({ console: false });
});
