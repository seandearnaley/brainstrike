import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED_REACT_DOCTOR_VERSION = '0.9.13';
const MINIMUM_RENAME_AWARE_VERSION = [0, 8, 2];

function parseStableVersion(version) {
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u.exec(version);
  return match?.groups
    ? [Number(match.groups.major), Number(match.groups.minor), Number(match.groups.patch)]
    : null;
}

function isAtLeast(version, minimum) {
  for (const [index, floor] of minimum.entries()) {
    const value = version[index] ?? 0;
    if (value !== floor) {
      return value > floor;
    }
  }
  return true;
}

function collectViolations({ actionCount, actionVersion, dependencyVersion }) {
  const violations = [];
  if (actionCount !== 1) {
    violations.push(
      `expected exactly one millionco/react-doctor@v2 action step, found ${actionCount}`
    );
  }
  if (dependencyVersion !== actionVersion) {
    violations.push(
      `React Doctor local/CI version skew: package.json=${dependencyVersion}, workflow=${actionVersion}`
    );
  }
  for (const [surface, version] of [
    ['package.json', dependencyVersion],
    ['workflow', actionVersion],
  ]) {
    const parsed = parseStableVersion(version);
    if (!parsed) {
      violations.push(`${surface} must use an exact stable React Doctor version, found ${version}`);
    } else if (!isAtLeast(parsed, MINIMUM_RENAME_AWARE_VERSION)) {
      violations.push(
        `${surface} pins ${version}, but React Doctor before 0.8.2 reclassifies findings in renamed files as new`
      );
    }
    if (version !== EXPECTED_REACT_DOCTOR_VERSION) {
      violations.push(
        `${surface} changed from the reviewed ${EXPECTED_REACT_DOCTOR_VERSION} pin; re-run the changed-scope controls and update this contract deliberately`
      );
    }
  }
  return violations;
}

function collectLocalCommandViolations(command) {
  const violations = [];
  if (!/^react-doctor\s+\.(?:\s|$)/u.test(command)) {
    violations.push(`root react-doctor script must scan '.', found '${command}'`);
  }
  if (!/(?:^|\s)--scope(?:=|\s+)full(?:\s|$)/u.test(command)) {
    violations.push('root react-doctor script must pass --scope full');
  }
  if (/(?:^|\s)--no-lint(?:\s|$)/u.test(command)) {
    violations.push('root react-doctor script must keep lint enabled for complete JSON coverage');
  }
  return violations;
}

function loadActualState() {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const workflow = parseYaml(
    readFileSync(path.join(repoRoot, '.github/workflows/react-doctor.yml'), 'utf8')
  );
  const actionSteps = workflow?.jobs?.['react-doctor']?.steps?.filter(
    (step) => step?.uses === 'millionco/react-doctor@v2'
  );
  return {
    actionCount: actionSteps?.length ?? 0,
    actionVersion: String(actionSteps?.[0]?.with?.version ?? ''),
    dependencyVersion: String(manifest.devDependencies?.['react-doctor'] ?? ''),
    localCommand: String(manifest.scripts?.['react-doctor'] ?? ''),
  };
}

test('React Doctor local and CI pins use the reviewed rename-aware release', () => {
  assert.deepEqual(collectViolations(loadActualState()), []);
});

test('React Doctor local command runs a lint-enabled full scan', () => {
  assert.deepEqual(collectLocalCommandViolations(loadActualState().localCommand), []);
});

test('money control: omitting full scope fails visibly', () => {
  assert.deepEqual(collectLocalCommandViolations('react-doctor .'), [
    'root react-doctor script must pass --scope full',
  ]);
});

test('money control: disabling lint makes incomplete JSON coverage fail visibly', () => {
  assert.deepEqual(collectLocalCommandViolations('react-doctor . --scope full --no-lint'), [
    'root react-doctor script must keep lint enabled for complete JSON coverage',
  ]);
});

test('money control: a downgrade to the rename-broken baseline implementation fails visibly', () => {
  const violations = collectViolations({
    actionCount: 1,
    actionVersion: '0.7.1',
    dependencyVersion: '0.7.1',
  });
  assert.match(violations.join('\n'), /before 0\.8\.2 reclassifies findings in renamed files/u);
});

test('money control: local/CI version skew fails visibly', () => {
  const violations = collectViolations({
    actionCount: 1,
    actionVersion: EXPECTED_REACT_DOCTOR_VERSION,
    dependencyVersion: '0.8.2',
  });
  assert.match(violations.join('\n'), /local\/CI version skew/u);
});
