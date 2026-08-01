import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CSS_BUNDLE_MIN_BYTES,
  TAILWIND_BASE_LAYER_PATTERN,
  validateCssBundle,
} from '../validate-css-bundle.mjs';

function withCssFixture(source, callback) {
  const directory = mkdtempSync(path.join(tmpdir(), 'validate-css-bundle-'));
  try {
    writeFileSync(path.join(directory, 'bundle.css'), source);
    return callback(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test('accepts the CSS bundle shape required by the CI gate', () => {
  withCssFixture(
    `${TAILWIND_BASE_LAYER_PATTERN}${'x'.repeat(CSS_BUNDLE_MIN_BYTES)}`,
    (directory) => {
      assert.deepEqual(validateCssBundle(directory), {
        cssSize: CSS_BUNDLE_MIN_BYTES + Buffer.byteLength(TAILWIND_BASE_LAYER_PATTERN),
        duplicateCount: 1,
      });
    }
  );
});

test('CONTROL: rejects a bundle below the minimum size', () => {
  withCssFixture(TAILWIND_BASE_LAYER_PATTERN, (directory) => {
    assert.throws(() => validateCssBundle(directory), /CSS bundle too small/);
  });
});

test('CONTROL: rejects duplicate Tailwind base layers', () => {
  withCssFixture(
    `${TAILWIND_BASE_LAYER_PATTERN.repeat(2)}${'x'.repeat(CSS_BUNDLE_MIN_BYTES)}`,
    (directory) => {
      assert.throws(
        () => validateCssBundle(directory),
        /Duplicate Tailwind layers detected \(2 copies\)/
      );
    }
  );
});
