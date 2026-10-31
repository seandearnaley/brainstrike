import { integrationLane } from '@brainstrike/test-utils/vitest.base';
import config from './vitest.config.mts';

export default integrationLane(config, ['__tests__/**/*.integration.test.ts']);
