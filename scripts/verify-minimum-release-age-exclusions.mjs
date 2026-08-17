// Guard: every entry in pnpm-workspace.yaml's `minimumReleaseAgeExclude:` list
// must be a SHORT-LIVED exception, not a standing exemption.
//
// WHY THIS EXISTS (raised in review of PR #2293). Each exclusion was justified
// at pin time against ONE specific fresh release — provenance checked, dist-tag
// checked, a named reason. That justification is inherently temporary: it says
// "this particular version is safe to install before it has aged", and it stops
// meaning anything the moment the version HAS aged. The entries carried a
// self-cleanup note ("remove once these versions age past whatever
// minimumReleaseAge floor is eventually configured"), but at the time NO floor
// was configured, so the note pointed at an event that never happens. Nothing
// ever triggered the cleanup and every entry quietly became permanent — a
// supply-chain exemption nobody re-decided. Control case: `@mastra/core@1.50.0`
// sat in the list for a month while the resolved version had already moved on,
// so the exemption covered a version the repo did not even install
// (docs/agents/mastra-boundary.md flagged it; nothing enforced it).
//
// The rule this guard enforces: an exclusion EXPIRES. An exclusion stops being
// load-bearing the moment the version is older than the configured
// `minimumReleaseAge` floor, because past that point the floor admits the
// version on its own. maxExclusionAgeDays() therefore DERIVES the window from
// that floor (floor + EXCLUSION_GRACE_DAYS) rather than hard-coding one, so the
// two numbers cannot drift into the state BST-1183 review caught: a 30-day
// window guarding a 3-day exception, i.e. 27 days of dead exemption — the very
// shape of the bug above.
//
// WHY A COMMITTED LEDGER RATHER THAN AN npm REGISTRY LOOKUP. The age check needs
// each version's publish date. Reading it live from registry.npmjs.org would put
// a network round-trip (and a network failure mode) inside `pnpm lint`, and the
// only honest response to an unreachable registry is to fail the lint — a guard
// that skipped its check when offline would be exactly the silent degradation
// this repo forbids. So the publish date is recorded ONCE, at pin time, in the
// committed ledger (EXCLUSION_LEDGER_PATH) by the same person who already reads
// that metadata to verify provenance. The guard is then offline, deterministic,
// and reviewable in the diff.
//
// The ledger and the YAML list must correspond 1:1 in both directions: an entry
// with no ledger record cannot be aged (it would be exempt from the expiry rule
// — the hole reopened), and a ledger record with no entry is stale bookkeeping
// that would later "explain" an exclusion someone re-adds for a different reason.
//
// To fix a failure: delete the expired entry from `minimumReleaseAgeExclude:` in
// pnpm-workspace.yaml AND its ledger record. Do NOT bump `publishedAt` to buy
// more time — the field records what npm published, and rewriting it converts a
// dated exception back into the permanent exemption this guard exists to stop.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Fallback window used ONLY when no `minimumReleaseAge` floor is configured.
 *
 * With no floor there is nothing to derive from, so this stays a deliberate
 * placeholder: far above any plausible floor (pnpm's own suggested setting is
 * 1440 minutes — one day), so the guard cannot fire while an exemption might
 * still be load-bearing.
 */
export const UNFLOORED_MAX_EXCLUSION_AGE_DAYS = 30;

/**
 * Slack between "the floor would now admit this version" and "the guard fails".
 *
 * An exclusion is genuinely dead the instant the version clears the floor.
 * failing at exactly that moment would turn every routine dependency bump into a
 * same-day cleanup chore, so one week of grace is allowed — enough to cover an
 * absence, short enough that a dead exemption cannot quietly become permanent.
 */
export const EXCLUSION_GRACE_DAYS = 7;

/**
 * Back-compat alias for the unfloored window. Fixture trees in the paired test
 * configure no floor, so this remains the value they age against.
 */
export const MAX_EXCLUSION_AGE_DAYS = UNFLOORED_MAX_EXCLUSION_AGE_DAYS;

/** Repo-relative path of the committed publish-date ledger. */
export const EXCLUSION_LEDGER_PATH = 'scripts/minimum-release-age-exclusions.json';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `name@version` with an EXACT version. Ranges, globs and bare package names are
 * rejected by design — see readExclusionEntries().
 *
 * `A-Z` is included because npm still hosts legacy mixed-case packages that
 * predate the lowercase rule (`JSONStream`, `Base64`) and remain installable.
 * Rejecting them here would fail with "not a `name@version` pin with an exact
 * version" — a message that misdiagnoses the problem and sends the reader
 * hunting for a version glob that is not there.
 */
const EXCLUSION_ENTRY_RE =
  /^(?:@[a-zA-Z0-9-~][a-zA-Z0-9-._~]*\/)?[a-zA-Z0-9-~][a-zA-Z0-9-._~]*@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)*$/;

/** The UTC timestamp shape npm's registry `time` map uses, copied verbatim. */
const PUBLISHED_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

/**
 * Every top-level spelling of the exclusion key that YAML treats as the same
 * key. `minimumReleaseAgeExclude :` (space before the colon) and a quoted key
 * are both valid YAML, and pnpm reads all of them — verified against the `yaml`
 * parser, where each yields `{ minimumReleaseAgeExclude: [...] }`.
 *
 * Anchored at column 0 so it cannot match the policy comment above the block
 * (comment lines start with `#`) or an indented key inside some other mapping.
 */
const EXCLUSION_KEY_DECLARATION_RE =
  /^(?:minimumReleaseAgeExclude|'minimumReleaseAgeExclude'|"minimumReleaseAgeExclude")\s*:/;

/**
 * Epoch milliseconds for a publish timestamp, or `null` when the string is not
 * a REAL UTC instant.
 *
 * A shape check alone is not enough, and in two different ways:
 *   - `2026-13-01T00:00:00Z` / `2026-07-06T25:00:00Z` match the shape but
 *     `Date.parse` returns NaN. Every comparison against NaN is false, so such
 *     an entry is neither "expired" nor "future" — it stays green forever, which
 *     is precisely the silent exemption this guard exists to prevent.
 *   - `2026-02-31T00:00:00Z` is worse than NaN: V8 accepts it and ROLLS IT OVER
 *     to 2026-03-03, so the entry silently ages from a date nobody wrote.
 *
 * Hence the round trip: re-read the parsed instant's UTC components and require
 * them to equal what was written. NaN fails the finiteness check; a rolled-over
 * date fails the component comparison.
 */
function parsePublishedAt(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const parts = PUBLISHED_AT_RE.exec(value);
  if (!parts) {
    return null;
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) {
    return null;
  }
  const instant = new Date(epoch);
  const written = parts.slice(1, 7).map(Number);
  const roundTripped = [
    instant.getUTCFullYear(),
    instant.getUTCMonth() + 1,
    instant.getUTCDate(),
    instant.getUTCHours(),
    instant.getUTCMinutes(),
    instant.getUTCSeconds(),
  ];
  return written.every((part, i) => part === roundTripped[i]) ? epoch : null;
}

/**
 * Parse the `minimumReleaseAgeExclude:` block from pnpm-workspace.yaml.
 *
 * Hand-parsed rather than via the `yaml` package for the same reason as
 * verify-catalog-references.mjs: `yaml` is a dependency of packages/ui, not the
 * workspace root, and pnpm's strict linking makes it unresolvable from scripts/.
 * Only the exact block shape this repo writes is supported; anything else throws
 * rather than under-reporting.
 *
 * An ABSENT key returns `[]` — that is the desired steady state (no standing
 * exemptions), not a parse failure.
 */
export function readExclusionEntries(repoRoot) {
  const yaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const lines = yaml.split('\n');

  // NO SILENT FALLBACK, and the detection has to be WIDER than the accepted
  // form. Anything YAML resolves to this key but that this parser does not model
  // — a populated flow sequence (`minimumReleaseAgeExclude: ['a@1.0.0']`), a
  // space before the colon, a quoted key, a second declaration — would otherwise
  // fall through as "no exclusions" and let every entry inside it escape both
  // ledger matching and the expiry rule while lint stayed green. So: detect
  // every spelling, accept only the two canonical ones, and throw on the rest.
  //
  // The EMPTY flow form is accepted precisely because nothing can hide in it —
  // and it is what this repo writes in the steady state, so the key stays
  // visible (with its policy comment) instead of vanishing whenever the list
  // empties out.
  const declarations = lines.filter((line) => EXCLUSION_KEY_DECLARATION_RE.test(line));
  if (declarations.length > 1) {
    throw new Error(
      'pnpm-workspace.yaml declares minimumReleaseAgeExclude more than once:\n' +
        declarations.map((line) => `  ${line}`).join('\n') +
        '\nYAML keeps only one of them, and this parser reads only the first, so entries under the others would ' +
        'be invisible to this guard. Merge them into a single block.'
    );
  }
  const [header] = declarations;
  if (header !== undefined && /^minimumReleaseAgeExclude:\s*\[\s*\]\s*$/.test(header)) {
    return [];
  }
  if (header !== undefined && !/^minimumReleaseAgeExclude:\s*$/.test(header)) {
    throw new Error(
      'verify-minimum-release-age-exclusions.mjs found a minimumReleaseAgeExclude declaration it does not model ' +
        `in pnpm-workspace.yaml:\n  ${header}\n` +
        'Only the block-sequence form (`minimumReleaseAgeExclude:` followed by indented `- name@version` items) ' +
        'and the empty flow sequence (`minimumReleaseAgeExclude: []`) are supported — write the key unquoted, ' +
        'with no space before the colon. pnpm reads the other spellings just fine, so a form this parser skipped ' +
        'would silently exempt every entry under it from the expiry rule.'
    );
  }

  const entries = [];
  let inBlock = false;
  for (const rawLine of lines) {
    if (/^minimumReleaseAgeExclude:\s*$/.test(rawLine)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) {
      continue;
    }
    if (rawLine.trim() === '' || /^\s*#/.test(rawLine)) {
      continue;
    }
    // YAML permits block-sequence items at the SAME indentation as their parent
    // key, so `- 'a@1.0.0'` at column 0 is a real entry, not the next top-level
    // key. Treating every non-indented line as a terminator made that form parse
    // as an empty list — a live exclusion reporting `OK (0 entries)`, verified
    // against this script. The terminator must therefore exclude sequence items,
    // and the item regex must accept zero indentation so they reach the loud
    // parser below rather than being dropped.
    if (/^\S/.test(rawLine) && !/^-\s/.test(rawLine)) {
      break; // next top-level key ends the block
    }
    const item = rawLine.match(/^\s*-\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*$/);
    if (!item) {
      // NO SILENT FALLBACK: an unparsed line inside the block would drop an
      // exclusion from the checked set and fake a green for it.
      throw new Error(
        'verify-minimum-release-age-exclusions.mjs could not parse this line inside the pnpm-workspace.yaml ' +
          `minimumReleaseAgeExclude: block:\n  ${rawLine}\n` +
          'Only simple `- name@version` list items (optionally quoted) are supported — including no trailing ' +
          'inline comment, which is the most likely cause here given how heavily commented this file is. Put ' +
          `the rationale in the "reason" field of ${EXCLUSION_LEDGER_PATH} instead: it survives, whereas an ` +
          'indented comment in this block is DELETED whenever pnpm rewrites pnpm-workspace.yaml (see the note ' +
          'at the top of that file). Otherwise, teach readExclusionEntries() the new shape rather than letting ' +
          'the entry escape the guard.'
      );
    }
    entries.push(validateExclusionEntry(item[1] ?? item[2] ?? item[3], rawLine));
  }
  return entries;
}

/**
 * Throw unless the entry pins ONE exact version.
 *
 * pnpm also accepts bare names and version globs here (`typescript`,
 * `typescript@5.*`). This repo does not use them and this guard refuses them:
 * such an entry is a blanket, open-ended exemption covering versions that do not
 * exist yet, so there is no publish date to age it against and no day on which
 * it becomes deletable. That is a permanent standing exemption by construction —
 * precisely what this guard exists to prevent — so it must be a deliberate,
 * re-decided change here, never something that slips in as a convenience.
 */
function validateExclusionEntry(entry, rawLine) {
  if (!EXCLUSION_ENTRY_RE.test(entry)) {
    throw new Error(
      'verify-minimum-release-age-exclusions.mjs rejects this pnpm-workspace.yaml minimumReleaseAgeExclude ' +
        `entry:\n  ${rawLine}\n` +
        `It yielded "${entry}", which is not a \`name@version\` pin with an exact version. A bare name or a ` +
        'version glob exempts releases that do not exist yet, so it can never age out and becomes a permanent ' +
        'standing exemption. Pin the single version you actually verified.'
    );
  }
  return entry;
}

/**
 * Parse the committed publish-date ledger: `name@version` → `{ publishedAt,
 * reason }`. Every field is validated here, because a record this guard cannot
 * read is a record it cannot age.
 */
export function readExclusionLedger(repoRoot) {
  const ledgerPath = path.join(repoRoot, EXCLUSION_LEDGER_PATH);
  const raw = readFileSync(ledgerPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // NO SILENT FALLBACK: an unparseable ledger is an unknown state, not an
    // empty one. Treating it as empty would report every exclusion as
    // unrecorded, or (worse, if inverted) age none of them.
    throw new Error(
      `verify-minimum-release-age-exclusions.mjs could not parse ${EXCLUSION_LEDGER_PATH}: ${err.message}. ` +
        'Fix the JSON; a ledger that does not parse cannot certify any exclusion.'
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${EXCLUSION_LEDGER_PATH} must be a JSON object mapping "name@version" to ` +
        '{ "publishedAt", "reason" }. Use {} when there are no exclusions.'
    );
  }

  const ledger = new Map();
  for (const [entry, record] of Object.entries(parsed)) {
    validateLedgerRecord(entry, record);
    ledger.set(entry, record);
  }
  return ledger;
}

/** Throw unless one ledger record carries an ageable, attributable exception. */
function validateLedgerRecord(entry, record) {
  if (!EXCLUSION_ENTRY_RE.test(entry)) {
    throw new Error(
      `${EXCLUSION_LEDGER_PATH} contains the key "${entry}", which is not a \`name@version\` pin with an exact ` +
        'version. Ledger keys must match the pnpm-workspace.yaml entries they explain.'
    );
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(
      `${EXCLUSION_LEDGER_PATH} record for "${entry}" must be an object with "publishedAt" and "reason".`
    );
  }
  if (parsePublishedAt(record.publishedAt) === null) {
    throw new Error(
      `${EXCLUSION_LEDGER_PATH} record for "${entry}" has publishedAt ${JSON.stringify(record.publishedAt)}, ` +
        'which is not a real UTC instant in ISO-8601 form (e.g. "2026-07-06T17:29:36.461Z"). A shape-valid but ' +
        'impossible date would leave the entry un-expirable (every comparison against NaN is false) or age it ' +
        'from a silently rolled-over day. Copy the value verbatim from the npm registry metadata: ' +
        `\`curl -s https://registry.npmjs.org/<name> | jq '.time["<version>"]'\`.`
    );
  }
  if (typeof record.reason !== 'string' || record.reason.trim() === '') {
    throw new Error(
      `${EXCLUSION_LEDGER_PATH} record for "${entry}" has no "reason". An exclusion whose justification is not ` +
        'written down cannot be re-decided by the next reader; state what this specific version was needed for.'
    );
  }
}

/**
 * Days elapsed between `publishedAt` and `now`, as a fractional number.
 *
 * Throws rather than returning NaN for an unreal instant. The invariant is
 * enforced here, not merely at ledger-validation time, because a NaN age
 * satisfies NEITHER comparison in findExclusionProblems() — the entry would
 * silently report no problem at all, which is the failure mode this whole guard
 * is about.
 */
export function exclusionAgeDays(publishedAt, now) {
  const epoch = parsePublishedAt(publishedAt);
  if (epoch === null) {
    throw new Error(
      `exclusionAgeDays: ${JSON.stringify(publishedAt)} is not a real UTC instant, so no age can be computed. ` +
        'Refusing to return NaN: it would compare false against every threshold and silently spare the entry.'
    );
  }
  return (now.getTime() - epoch) / MS_PER_DAY;
}

/**
 * The configured `minimumReleaseAge` floor in DAYS, or `null` when the setting
 * is absent. pnpm expresses it in minutes.
 *
 * This repo DOES configure a floor (BST-1183), so a `null` here is a red flag —
 * either the setting was removed, which is a supply-chain relaxation, or this
 * parser stopped matching it. The paired test asserts a real value for that
 * reason. `null` remains meaningful for fixture trees and for any consumer that
 * has not configured one.
 *
 * The key regex stops at `\s*:`, so `minimumReleaseAgeExclude:` — which shares
 * the prefix — cannot match it.
 */
export function readMinimumReleaseAgeFloorDays(repoRoot) {
  const yaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const declaration = yaml
    .split('\n')
    .find((line) =>
      /^(?:minimumReleaseAge|'minimumReleaseAge'|"minimumReleaseAge")\s*:/.test(line)
    );
  if (declaration === undefined) {
    return null;
  }
  const value = declaration.match(/:\s*(\d+)\s*$/);
  if (!value) {
    throw new Error(
      `verify-minimum-release-age-exclusions.mjs could not read the minimumReleaseAge value from:\n  ${declaration}\n` +
        'Only a plain integer number of minutes is supported. This guard DERIVES its expiry window from that ' +
        'floor, so an unreadable value would leave the window undefined.'
    );
  }
  return Number(value[1]) / (60 * 24);
}

/**
 * The age at which an exclusion must be deleted, DERIVED from the configured
 * floor.
 *
 * An exclusion is load-bearing only while the version is younger than the
 * floor — past that, pnpm admits it unaided and the entry is dead weight. So the
 * window is `floor + EXCLUSION_GRACE_DAYS`, and the old inversion hazard
 * (a floor at or above a hard-coded window, which would order deletion of
 * exclusions pnpm still needs) is impossible by construction rather than by a
 * separate assertion.
 *
 * With no floor configured there is nothing to derive from, so the deliberate
 * UNFLOORED_MAX_EXCLUSION_AGE_DAYS placeholder applies.
 */
export function maxExclusionAgeDays(repoRoot) {
  const floorDays = readMinimumReleaseAgeFloorDays(repoRoot);
  return floorDays === null ? UNFLOORED_MAX_EXCLUSION_AGE_DAYS : floorDays + EXCLUSION_GRACE_DAYS;
}

/**
 * Every problem with the current exclusion set, in all three directions:
 *
 *  - kind 'expired'               — the excluded version has aged past the
 *    threshold, so the exemption is inert and must be deleted.
 *  - kind 'missing-ledger-record' — a YAML entry with no publish date recorded,
 *    which cannot be aged at all (the exemption would be permanent again).
 *  - kind 'orphan-ledger-record'  — a ledger record whose YAML entry is gone;
 *    stale bookkeeping that would later appear to justify an unrelated re-add.
 *  - kind 'future-publish-date'   — a `publishedAt` after `now`, which would
 *    make the entry un-expirable. Nothing published in the future exists.
 *
 * `entries` defaults to reading them here, and exists so main() can report the
 * entry count without parsing pnpm-workspace.yaml a second time. The default is
 * evaluated lazily, so every other caller is unaffected.
 *
 * @param {{ repoRoot: string, now?: Date, entries?: string[] }} options
 */
export function findExclusionProblems({
  repoRoot,
  now = new Date(),
  entries = readExclusionEntries(repoRoot),
}) {
  const maxAgeDays = maxExclusionAgeDays(repoRoot);
  const ledger = readExclusionLedger(repoRoot);
  const problems = [];

  for (const entry of entries) {
    const record = ledger.get(entry);
    if (record === undefined) {
      problems.push({ entry, kind: 'missing-ledger-record' });
      continue;
    }
    const ageDays = exclusionAgeDays(record.publishedAt, now);
    if (ageDays < 0) {
      problems.push({ ageDays, entry, kind: 'future-publish-date', record });
      continue;
    }
    if (ageDays > maxAgeDays) {
      problems.push({ ageDays, entry, kind: 'expired', maxAgeDays, record });
    }
  }

  const excluded = new Set(entries);
  for (const [entry, record] of ledger) {
    if (!excluded.has(entry)) {
      problems.push({ entry, kind: 'orphan-ledger-record', record });
    }
  }
  return problems;
}

/**
 * Human-readable report. The remedy differs per kind, and a single generic
 * message would send half the readers to the wrong file.
 */
export function formatExclusionProblems(problems) {
  return problems.map((problem) => `  ${describeProblem(problem)}`).join('\n');
}

function describeProblem(problem) {
  if (problem.kind === 'expired') {
    return (
      `${problem.entry} was published ${problem.record.publishedAt} — ${Math.floor(problem.ageDays)} days ago, ` +
      `past the ${problem.maxAgeDays}-day limit. The exception has served its purpose (recorded reason: ` +
      `${problem.record.reason}). DELETE it from minimumReleaseAgeExclude: in pnpm-workspace.yaml and delete its ` +
      `record from ${EXCLUSION_LEDGER_PATH}. Do not extend publishedAt.`
    );
  }
  if (problem.kind === 'missing-ledger-record') {
    return (
      `${problem.entry} is excluded in pnpm-workspace.yaml but has no record in ${EXCLUSION_LEDGER_PATH}, so ` +
      'nothing can ever expire it. Add { "publishedAt": <the npm publish timestamp>, "reason": <why this exact ' +
      'version was needed early> } — or drop the exclusion.'
    );
  }
  if (problem.kind === 'orphan-ledger-record') {
    return (
      `${problem.entry} has a record in ${EXCLUSION_LEDGER_PATH} but is no longer in ` +
      'minimumReleaseAgeExclude:. Delete the record; leaving it behind makes it look like a future re-add is ' +
      'already justified.'
    );
  }
  return (
    `${problem.entry} records publishedAt ${problem.record.publishedAt}, which is in the future. A version that ` +
    'has not been published cannot be aged out, so this entry could never expire. Use the timestamp npm ' +
    'actually reports.'
  );
}

/**
 * @param {{ repoRoot?: string, now?: Date }} options
 */
export function main(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const now = options.now ?? new Date();
  // Parsed once and threaded through: the success message reports the entry
  // count, and re-reading pnpm-workspace.yaml for it would be a second parse of
  // a file that could have changed in between.
  const entries = readExclusionEntries(repoRoot);
  const problems = findExclusionProblems({ entries, now, repoRoot });

  if (problems.length === 0) {
    const count = entries.length;
    console.log(
      `verify-minimum-release-age-exclusions: OK (${count} minimumReleaseAgeExclude entr${count === 1 ? 'y' : 'ies'}` +
        `, none older than ${maxExclusionAgeDays(repoRoot)} days)`
    );
    return;
  }
  console.error('minimumReleaseAgeExclude entries that must not stand:');
  console.error(formatExclusionProblems(problems));
  process.exitCode = 1;
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main();
}
