import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `apps/web/e2e/utils/explorer-import.ts` and its desktop counterpart are
 * deliberate duplicates: the two Playwright projects live in separate apps with
 * separate tsconfigs and no shared e2e package (BST-1212). Duplication is the
 * accepted cost; silent DIVERGENCE is not — it would leave the import flow
 * covered on one platform and quietly unexercised on the other.
 *
 * The only sanctioned difference is the pointer each copy carries to the other,
 * so that line is normalized away and everything else must match byte for byte.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const TWINS = [
  {
    label: 'web',
    path: 'apps/web/e2e/utils/explorer-import.ts',
    pointsAt: 'apps/desktop/e2e/utils/explorer-import.ts',
  },
  {
    label: 'desktop',
    path: 'apps/desktop/e2e/utils/explorer-import.ts',
    pointsAt: 'apps/web/e2e/utils/explorer-import.ts',
  },
];

function readTwin(twin) {
  const source = readFileSync(path.join(repoRoot, twin.path), 'utf8');
  const pointer = ` * TWIN FILE — keep in sync with \`${twin.pointsAt}\`.`;
  assert.ok(
    source.includes(pointer),
    `${twin.path} must carry the twin pointer to ${twin.pointsAt} so the duplication is self-documenting`
  );
  return source.replace(pointer, ' * TWIN FILE — keep in sync with its counterpart.');
}

test('explorer-import e2e helpers stay byte-identical across web and desktop', () => {
  const [web, desktop] = TWINS.map(readTwin);

  assert.equal(
    web,
    desktop,
    'apps/web and apps/desktop explorer-import helpers have diverged. Copy the change into both, or delete this contract if the duplication is being replaced by a shared package.'
  );
});
