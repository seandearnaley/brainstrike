// @vitest-environment node
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { test } from 'vitest';
import { qualifyOrdinaryAppIndexedText } from './helpers/ordinary-app-owned-indexed-text';

test('quitting the ordinary app joins its host and live native owners before Root release', {
  timeout: getAdjustedTimeout('e2e'),
}, async () => {
  await qualifyOrdinaryAppIndexedText({ stopHost: true });
});
