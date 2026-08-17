import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXCLUSION_GRACE_DAYS,
  EXCLUSION_LEDGER_PATH,
  exclusionAgeDays,
  findExclusionProblems,
  formatExclusionProblems,
  MAX_EXCLUSION_AGE_DAYS,
  maxExclusionAgeDays,
  readExclusionEntries,
  readExclusionLedger,
  readMinimumReleaseAgeFloorDays,
  UNFLOORED_MAX_EXCLUSION_AGE_DAYS,
} from '../verify-minimum-release-age-exclusions.mjs';

/**
 * Contract for the minimumReleaseAgeExclude expiry guard. The REAL-TREE tests
 * are the live enforcement; the fixture tests prove the guard actually detects
 * what it claims to. A guard whose failure path is never exercised is a guard
 * you are trusting on faith — and this one's failure path only fires with the
 * passage of time, so it would otherwise go years without being exercised at
 * all.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A fixed clock, so no assertion below depends on the day the suite runs. */
const NOW = new Date('2026-08-06T12:00:00.000Z');

function daysBefore(date, days) {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Build a synthetic workspace holding just the two files this guard reads: a
 * pnpm-workspace.yaml exclusion block and the committed ledger.
 */
function makeFixture({ exclusionsYaml, ledger }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-age-guard-'));
  writeFileSync(
    path.join(dir, 'pnpm-workspace.yaml'),
    `packages:\n  - packages/*\ncatalogMode: strict\n${exclusionsYaml}`
  );
  mkdirSync(path.join(dir, path.dirname(EXCLUSION_LEDGER_PATH)), { recursive: true });
  writeFileSync(
    path.join(dir, EXCLUSION_LEDGER_PATH),
    typeof ledger === 'string' ? ledger : JSON.stringify(ledger, null, 2)
  );
  return dir;
}

function withFixture(fixture, assertions) {
  const dir = makeFixture(fixture);
  try {
    assertions(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test('the real repo tree has no expired or unrecorded exclusions', () => {
  const problems = findExclusionProblems({ repoRoot });
  assert.deepEqual(
    problems,
    [],
    `minimumReleaseAgeExclude entries that must not stand:\n${formatExclusionProblems(problems)}`
  );
});

test('the real ledger parses and corresponds 1:1 with the real exclusion list', () => {
  // Reads both real files through the strict parsers, so a malformed committed
  // ledger or an unparseable block fails here rather than being discovered the
  // day someone next adds an exclusion.
  const entries = readExclusionEntries(repoRoot);
  const ledger = readExclusionLedger(repoRoot);
  assert.deepEqual(
    [...ledger.keys()].sort(),
    [...entries].sort(),
    `pnpm-workspace.yaml minimumReleaseAgeExclude and ${EXCLUSION_LEDGER_PATH} must list exactly the same ` +
      'entries — every exclusion needs a publish date to age it, and every record needs an exclusion to explain.'
  );
});

test('MONEY TEST: an exclusion older than the threshold FAILS the guard', () => {
  // The defect this exists for: an exception justified against one fresh release
  // silently becomes a permanent standing exemption because nothing ever
  // revisits it. Age is the thing that must make it fail.
  withFixture(
    {
      exclusionsYaml: "minimumReleaseAgeExclude:\n  - '@mastra/core@1.50.0'\n",
      ledger: {
        '@mastra/core@1.50.0': {
          publishedAt: daysBefore(NOW, MAX_EXCLUSION_AGE_DAYS + 1),
          reason: 'shipped the tool-approval fix this repo needed',
        },
      },
    },
    (dir) => {
      const problems = findExclusionProblems({ now: NOW, repoRoot: dir });
      assert.equal(problems.length, 1);
      assert.equal(problems[0].kind, 'expired');
      assert.equal(problems[0].entry, '@mastra/core@1.50.0');
      assert.match(formatExclusionProblems(problems), /DELETE it from minimumReleaseAgeExclude/);
    }
  );
});

test('an exclusion still inside the window PASSES (the guard is not a blanket ban)', () => {
  withFixture(
    {
      exclusionsYaml: "minimumReleaseAgeExclude:\n  - '@mastra/core@1.50.0'\n",
      ledger: {
        '@mastra/core@1.50.0': {
          publishedAt: daysBefore(NOW, MAX_EXCLUSION_AGE_DAYS - 1),
          reason: 'provenance-verified fresh release',
        },
      },
    },
    (dir) => {
      assert.deepEqual(findExclusionProblems({ now: NOW, repoRoot: dir }), []);
    }
  );
});

test('BLIND SPOT: an exclusion with no ledger record is reported, not skipped', () => {
  // Without this, the cheapest way to make the guard stop complaining would be
  // to delete the ledger record — restoring the un-ageable exemption exactly.
  withFixture(
    {
      exclusionsYaml: "minimumReleaseAgeExclude:\n  - 'left-pad@1.3.0'\n",
      ledger: {},
    },
    (dir) => {
      const problems = findExclusionProblems({ now: NOW, repoRoot: dir });
      assert.equal(problems.length, 1);
      assert.equal(problems[0].kind, 'missing-ledger-record');
    }
  );
});

test('a ledger record whose exclusion is gone is reported as an orphan', () => {
  withFixture(
    {
      exclusionsYaml: 'minimumReleaseAgeExclude: []\n',
      ledger: {
        'left-pad@1.3.0': { publishedAt: daysBefore(NOW, 1), reason: 'stale bookkeeping' },
      },
    },
    (dir) => {
      const problems = findExclusionProblems({ now: NOW, repoRoot: dir });
      assert.equal(problems.length, 1);
      assert.equal(problems[0].kind, 'orphan-ledger-record');
    }
  );
});

test('a future publishedAt is rejected rather than granting an un-expirable entry', () => {
  withFixture(
    {
      exclusionsYaml: "minimumReleaseAgeExclude:\n  - 'left-pad@1.3.0'\n",
      ledger: {
        'left-pad@1.3.0': { publishedAt: daysBefore(NOW, -5), reason: 'buying time' },
      },
    },
    (dir) => {
      const problems = findExclusionProblems({ now: NOW, repoRoot: dir });
      assert.equal(problems.length, 1);
      assert.equal(problems[0].kind, 'future-publish-date');
    }
  );
});

test('a bare name or version glob is REFUSED: neither can ever age out', () => {
  for (const entry of ['typescript', 'typescript@5.*', '@mastra/core@^1.50.0']) {
    withFixture(
      { exclusionsYaml: `minimumReleaseAgeExclude:\n  - '${entry}'\n`, ledger: {} },
      (dir) => {
        assert.throws(
          () => findExclusionProblems({ now: NOW, repoRoot: dir }),
          /not a `name@version` pin with an exact version/,
          `"${entry}" is an open-ended exemption and must be rejected`
        );
      }
    );
  }
});

test('a populated inline flow sequence THROWS instead of parsing as empty', () => {
  // The parser's own blind spot: the flow form does not match the block header,
  // so a naive reader would report "no exclusions" for a list that has some.
  withFixture(
    { exclusionsYaml: "minimumReleaseAgeExclude: ['left-pad@1.3.0']\n", ledger: {} },
    (dir) => {
      assert.throws(
        () => readExclusionEntries(dir),
        /declaration it does not model/,
        'a populated flow sequence must not be silently read as an empty list'
      );
    }
  );
});

test('BLIND SPOT: alternate YAML spellings of the key are REFUSED, not read as empty', () => {
  // All three are valid YAML that pnpm reads as the same key (verified against
  // the `yaml` parser: each yields {minimumReleaseAgeExclude: ['left-pad@1.3.0']}).
  // A literal `^minimumReleaseAgeExclude:` match misses every one of them and
  // returns "no exclusions" — entries would bypass ledger matching AND expiry
  // while lint stays green, which is the exact hole this guard exists to close.
  for (const spelling of [
    'minimumReleaseAgeExclude :',
    "'minimumReleaseAgeExclude':",
    '"minimumReleaseAgeExclude":',
  ]) {
    withFixture({ exclusionsYaml: `${spelling}\n  - 'left-pad@1.3.0'\n`, ledger: {} }, (dir) => {
      assert.throws(
        () => readExclusionEntries(dir),
        /minimumReleaseAgeExclude/,
        `"${spelling}" must not be silently read as an empty list`
      );
    });
  }
});

test('a duplicated exclusion key is REFUSED rather than half-read', () => {
  // Only the first block would be scanned, so entries under the second would be
  // invisible to the guard while pnpm still honours one of them.
  withFixture(
    {
      exclusionsYaml:
        "minimumReleaseAgeExclude:\n  - 'left-pad@1.3.0'\nminimumReleaseAgeExclude:\n  - 'right-pad@2.0.0'\n",
      ledger: {},
    },
    (dir) => {
      assert.throws(() => readExclusionEntries(dir), /more than once/);
    }
  );
});

test('BLIND SPOT: a calendar-invalid publishedAt is REFUSED, not silently un-ageable', () => {
  // Shape-valid but impossible timestamps. `2026-13-01` and `25:00:00` make
  // Date.parse return NaN, so BOTH `age < 0` and `age > 30` are false and the
  // entry stays green forever. `2026-02-31` is worse than NaN: V8 silently ROLLS
  // IT OVER to 2026-03-03, so the entry ages from a date nobody wrote.
  for (const publishedAt of [
    '2026-13-01T00:00:00Z',
    '2026-02-31T00:00:00Z',
    '2026-07-06T25:00:00Z',
    '2026-00-10T00:00:00Z',
  ]) {
    withFixture(
      {
        exclusionsYaml: "minimumReleaseAgeExclude:\n  - 'left-pad@1.3.0'\n",
        ledger: { 'left-pad@1.3.0': { publishedAt, reason: 'typo or fabrication' } },
      },
      (dir) => {
        assert.throws(
          () => findExclusionProblems({ now: NOW, repoRoot: dir }),
          /real UTC instant/,
          `${publishedAt} is not a real instant and must be rejected`
        );
      }
    );
  }
});

test('exclusionAgeDays refuses to return NaN for an unparseable timestamp', () => {
  // Guards the invariant locally instead of relying on validation having run
  // first: a NaN age silently satisfies neither comparison in findExclusionProblems.
  assert.throws(() => exclusionAgeDays('2026-13-01T00:00:00Z', NOW), /real UTC instant/);
});

test('BLIND SPOT: a zero-indented block sequence is READ, not silently dropped', () => {
  // YAML allows sequence items at the same indentation as their parent key.
  // Treating every non-indented line as the next top-level key made this parse
  // as an empty list, so a live exclusion printed "OK (0 entries)" — verified
  // against this script before the fix.
  withFixture(
    {
      exclusionsYaml: "minimumReleaseAgeExclude:\n- '@mastra/core@1.50.0'\n",
      ledger: {},
    },
    (dir) => {
      assert.deepEqual(readExclusionEntries(dir), ['@mastra/core@1.50.0']);
      const problems = findExclusionProblems({ now: NOW, repoRoot: dir });
      assert.equal(problems.length, 1, 'the entry must reach the checks, not vanish');
      assert.equal(problems[0].kind, 'missing-ledger-record');
    }
  );
});

test('a zero-indented block sequence still ends at the next top-level key', () => {
  withFixture(
    {
      exclusionsYaml:
        "minimumReleaseAgeExclude:\n- 'left-pad@1.3.0'\nonlyBuiltDependencies:\n  - esbuild\n",
      ledger: {},
    },
    (dir) => {
      assert.deepEqual(readExclusionEntries(dir), ['left-pad@1.3.0']);
    }
  );
});

test('a legacy mixed-case package name is accepted', () => {
  // npm still hosts pre-lowercase-rule names. Rejecting them would fail with a
  // message about version globs, which misdiagnoses the problem.
  withFixture(
    { exclusionsYaml: "minimumReleaseAgeExclude:\n  - 'JSONStream@1.3.5'\n", ledger: {} },
    (dir) => {
      assert.deepEqual(readExclusionEntries(dir), ['JSONStream@1.3.5']);
    }
  );
});

test('a floor shorter than the window is fine, and does not match the Exclude key', () => {
  withFixture(
    {
      exclusionsYaml: "minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - 'left-pad@1.3.0'\n",
      ledger: {
        'left-pad@1.3.0': { publishedAt: daysBefore(NOW, 2), reason: 'fresh, floor is 1 day' },
      },
    },
    (dir) => {
      assert.equal(readMinimumReleaseAgeFloorDays(dir), 1);
      assert.deepEqual(findExclusionProblems({ now: NOW, repoRoot: dir }), []);
    }
  );
});

test('the real repo configures a minimumReleaseAge floor, and it clears the expiry window', () => {
  // BST-1183 switched the floor on. Asserting the concrete value keeps the
  // supply-chain policy from being silently relaxed or removed — and the
  // relational assertion is the one the guard's own remedy depends on.
  // A LOWER BOUND, not equality: the intent is to stop the floor being silently
  // relaxed or removed. Equality would also fail when someone STRENGTHENS the
  // policy, and the failure message would tell them to undo a change that makes
  // the repo safer.
  //
  // REMOVAL is asserted SEPARATELY and deliberately, not folded into the bound.
  // readMinimumReleaseAgeFloorDays returns null when the key is absent, and
  // `null >= 1` is false — so today the bound alone would catch it. But `null`
  // coerces to 0, so `null >= 0` is TRUE: the moment anyone tunes
  // MINIMUM_POLICY_FLOOR_DAYS to 0, deleting `minimumReleaseAge` outright would
  // pass this test silently. That is a strictly larger relaxation than any
  // tuning this test is meant to permit, arriving with no tripwire, in the file
  // whose entire job is to be the tripwire. Keep these two assertions separate
  // so the removal guarantee is independent of whatever the floor is tuned to.
  //
  // RE-DECIDED 2026-08-15 (BST-1302): 3 -> 1 day. This tripwire did its job —
  // it caught the change and forced the decision to be made here, in the open,
  // rather than in a one-character yaml edit. The reasoning, recorded so the
  // next person can weigh it rather than inherit it:
  //
  //   The 2026-08 dependency sweep hit the 3-day floor on 25 of 94 outdated
  //   packages at once (mastra, the PGlite triple, all three AI SDK providers,
  //   stryker, pragmatic-dnd, swc, turbo). None could land in that pass, and
  //   each would otherwise need its own pinned exclusion plus ledger record —
  //   so the floor's practical effect was to push toward blanket exclusions,
  //   which are strictly worse than a shorter floor. 1 day still refuses the
  //   same-day malicious publish, which is where most compromised-maintainer
  //   and typosquat publishes are caught and unpublished; what it gives up is
  //   the tail of that detection window.
  //
  // This is a real loosening of a security control, not a tuning tweak. If the
  // upgrade cadence stops justifying it, raise it back — that is a one-line
  // change and this test will not object to it.
  const MINIMUM_POLICY_FLOOR_DAYS = 1;
  const floorDays = readMinimumReleaseAgeFloorDays(repoRoot);
  assert.notEqual(
    floorDays,
    null,
    'pnpm-workspace.yaml must declare a minimumReleaseAge floor at all. Removing the setting is a ' +
      'supply-chain relaxation that has to be re-decided here — and `null >= 0` is true, so the bound ' +
      'below cannot be relied on to catch removal once the floor is tuned to 0.'
  );
  assert.ok(
    floorDays >= MINIMUM_POLICY_FLOOR_DAYS,
    `pnpm-workspace.yaml must keep a minimumReleaseAge floor of at least ${MINIMUM_POLICY_FLOOR_DAYS} day(s) (read ${floorDays}). Raising it ` +
      'is fine; lowering or removing it is a supply-chain relaxation that has to be re-decided here.'
  );
  // The window is DERIVED from the floor, so the inversion this used to assert
  // against is impossible by construction — assert the derivation instead.
  assert.equal(
    maxExclusionAgeDays(repoRoot),
    floorDays + EXCLUSION_GRACE_DAYS,
    'the expiry window must track the configured floor, not a hard-coded constant'
  );
});

test('the expiry window is derived from the floor, not left at the unfloored placeholder', () => {
  // BST-1183 review: a 30-day window guarding a 3-day exception leaves 27 days
  // of dead exemption — the same shape as the bug the guard was written for.
  withFixture(
    { exclusionsYaml: 'minimumReleaseAge: 4320\nminimumReleaseAgeExclude: []\n', ledger: {} },
    (dir) => {
      assert.equal(maxExclusionAgeDays(dir), 3 + EXCLUSION_GRACE_DAYS);
    }
  );
  withFixture({ exclusionsYaml: 'minimumReleaseAgeExclude: []\n', ledger: {} }, (dir) => {
    assert.equal(
      maxExclusionAgeDays(dir),
      UNFLOORED_MAX_EXCLUSION_AGE_DAYS,
      'with no floor there is nothing to derive from, so the placeholder applies'
    );
  });
});

test('MONEY TEST: the derived window expires an entry the old 30-day one would have kept', () => {
  // 12 days old under a 3-day floor: dead for 9 days. The unfloored window would
  // still call this fine, which is exactly the gap the derivation closes.
  withFixture(
    {
      exclusionsYaml: "minimumReleaseAge: 4320\nminimumReleaseAgeExclude:\n  - 'left-pad@1.3.0'\n",
      ledger: {
        'left-pad@1.3.0': {
          publishedAt: daysBefore(NOW, 12),
          reason: 'long since admitted by the floor',
        },
      },
    },
    (dir) => {
      const problems = findExclusionProblems({ now: NOW, repoRoot: dir });
      assert.equal(problems.length, 1);
      assert.equal(problems[0].kind, 'expired');
      assert.equal(problems[0].maxAgeDays, 10);
      assert.ok(UNFLOORED_MAX_EXCLUSION_AGE_DAYS > 12, 'the old window would have passed this');
    }
  );
});

test('a floor at or above the old placeholder no longer inverts anything', () => {
  // The previous assertMaxAgeClearsFloor() existed to catch floor >= window.
  // With derivation that state cannot occur: the window always exceeds the floor.
  withFixture(
    { exclusionsYaml: 'minimumReleaseAge: 86400\nminimumReleaseAgeExclude: []\n', ledger: {} },
    (dir) => {
      const floorDays = readMinimumReleaseAgeFloorDays(dir);
      assert.equal(floorDays, 60);
      assert.ok(maxExclusionAgeDays(dir) > floorDays);
      assert.deepEqual(findExclusionProblems({ now: NOW, repoRoot: dir }), []);
    }
  );
});

test('a trailing inline comment throws, and the message says where the reason belongs', () => {
  // Failing loud is right, but the surrounding file is heavily commented, so
  // this is a natural thing for a maintainer to write. The message has to point
  // at the ledger's reason field — and note that a comment here would be erased
  // by pnpm's own rewrites anyway.
  withFixture(
    {
      exclusionsYaml: "minimumReleaseAgeExclude:\n  - 'left-pad@1.3.0' # needed early\n",
      ledger: {},
    },
    (dir) => {
      assert.throws(() => readExclusionEntries(dir), /trailing\s+inline comment/);
      assert.throws(() => readExclusionEntries(dir), /"reason" field/);
    }
  );
});

test('the empty flow sequence is the accepted steady state', () => {
  withFixture({ exclusionsYaml: 'minimumReleaseAgeExclude: []\n', ledger: {} }, (dir) => {
    assert.deepEqual(readExclusionEntries(dir), []);
  });
});

test('an absent minimumReleaseAgeExclude key reads as no exclusions', () => {
  withFixture({ exclusionsYaml: '', ledger: {} }, (dir) => {
    assert.deepEqual(readExclusionEntries(dir), []);
  });
});

test('an unparseable list item THROWS rather than dropping the entry', () => {
  withFixture(
    { exclusionsYaml: 'minimumReleaseAgeExclude:\n  - {weird: shape}\n', ledger: {} },
    (dir) => {
      assert.throws(() => readExclusionEntries(dir), /could not parse this line/);
    }
  );
});

test('the block ends at the next top-level key', () => {
  withFixture(
    {
      exclusionsYaml:
        "minimumReleaseAgeExclude:\n  - 'left-pad@1.3.0'\nonlyBuiltDependencies:\n  - esbuild\n",
      ledger: {},
    },
    (dir) => {
      assert.deepEqual(readExclusionEntries(dir), ['left-pad@1.3.0']);
    }
  );
});

test('a malformed ledger THROWS rather than reading as empty', () => {
  const cases = [
    ['not json at all', /could not parse/],
    ['[]', /must be a JSON object/],
    ['{"left-pad@1.3.0": {"reason": "no date"}}', /not a real UTC instant/],
    ['{"left-pad@1.3.0": {"publishedAt": "2026-07-01T00:00:00.000Z"}}', /has no "reason"/],
    ['{"left-pad": {"publishedAt": "2026-07-01T00:00:00.000Z", "reason": "x"}}', /exact version/],
  ];
  for (const [ledger, expected] of cases) {
    withFixture({ exclusionsYaml: 'minimumReleaseAgeExclude: []\n', ledger }, (dir) => {
      assert.throws(() => readExclusionLedger(dir), expected, `ledger ${ledger} must be rejected`);
    });
  }
});

test('exclusionAgeDays measures from the publish timestamp', () => {
  assert.equal(exclusionAgeDays('2026-08-01T12:00:00.000Z', NOW), 5);
});
