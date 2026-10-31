import { expect, it } from 'vitest';

it('imports runtime export modules without throwing', { timeout: 20_000 }, async () => {
  await expect(import('../src/playwright-environment')).resolves.toBeTruthy();
  await expect(import('../src/vitest-browser')).resolves.toBeTruthy();
});
