// @vitest-environment node
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { test } from 'vitest';
import { qualifyOrdinaryAppIndexedText } from './helpers/ordinary-app-owned-indexed-text';

test('ordinary app-owned Stop joins its live native owners before Root release', {
  timeout: getAdjustedTimeout('e2e'),
}, async () => {
  await qualifyOrdinaryAppIndexedText({ stopHost: true });
});
