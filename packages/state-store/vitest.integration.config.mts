import { integrationLane } from '@brainstrike/test-utils/vitest.base';
import config from './vitest.config.mts';

export default integrationLane(config, ['**/*.integration.test.?(c|m)[jt]s?(x)']);
