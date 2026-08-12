import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const devProxySource = readFileSync(
  new URL('../../apps/web/src/hf-dev-proxy.ts', import.meta.url),
  'utf8'
);
const productionProxySource = readFileSync(
  new URL('../../apps/web/src/app/api/hf/[...path]/route.ts', import.meta.url),
  'utf8'
);

const sharedConstantNames = [
  'HUGGING_FACE_BASE_URL',
  'ALLOWED_MODEL_ID',
  'FORWARDED_REQUEST_HEADERS',
  'PASSTHROUGH_RESPONSE_HEADERS',
];

describe('Hugging Face proxy contract ownership', () => {
  for (const [name, source] of [
    ['development proxy', devProxySource],
    ['production proxy', productionProxySource],
  ]) {
    it(`${name} imports the shared constants instead of redeclaring them`, () => {
      assert.match(source, /from ['"].*hf-proxy-contract\.js['"]/);
      for (const constantName of sharedConstantNames) {
        assert.doesNotMatch(source, new RegExp(`const\\s+${constantName}\\s*=`));
      }
    });
  }
});
