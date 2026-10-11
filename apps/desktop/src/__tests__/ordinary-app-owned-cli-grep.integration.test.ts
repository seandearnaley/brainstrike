// @vitest-environment node
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { test } from 'vitest';
import { qualifyOrdinaryAppIndexedText } from './helpers/ordinary-app-owned-indexed-text';

test('the real CLI retrieves scoped indexed and live literal text through the ordinary host', {
  timeout: getAdjustedTimeout('e2e'),
}, async () => {
  await qualifyOrdinaryAppIndexedText({ cliGrep: true });
});
