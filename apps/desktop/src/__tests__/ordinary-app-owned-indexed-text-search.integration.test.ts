// @vitest-environment node
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { test } from 'vitest';
import { qualifyOrdinaryAppIndexedText } from './helpers/ordinary-app-owned-indexed-text';

test('ordinary app-owned Root returns legitimately indexed text through grep', {
  timeout: getAdjustedTimeout('e2e'),
}, async () => {
  await qualifyOrdinaryAppIndexedText();
});
