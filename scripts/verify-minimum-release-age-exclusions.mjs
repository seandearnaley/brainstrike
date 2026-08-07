// Guard: every entry in pnpm-workspace.yaml's `minimumReleaseAgeExclude:` list
// must be a SHORT-LIVED exception, not a standing exemption.
//
// WHY THIS EXISTS (raised in review of PR #2293). Each exclusion was justified
// at pin time against ONE specific fresh release — provenance checked, dist-tag
// checked, a named reason. That justification is inherently temporary: it says
// "this particular version is safe to install before it has aged", and it stops
// meaning anything the moment the version HAS aged. The entries carried a
// self-cleanup note ("remove once these versions age past whatever
// minimumReleaseAge floor is eventually configured"), but no floor is configured
// in this repo, so the note pointed at an event that never happens. Nothing ever
// triggered the cleanup and every entry quietly became permanent — a supply-chain
// exemption nobody re-decided. Control case: `@mastra/core@1.50.0` sat in the
// list for a month while the resolved version had already moved to ^1.51.0, so
// the exemption covered a version the repo does not even install
// (docs/agents/mastra-boundary.md flagged it; nothing enforced it).
//
// The rule this guard enforces: an exclusion EXPIRES. Once the excluded version
// is older than MAX_EXCLUSION_AGE_DAYS, any `minimumReleaseAge` floor this repo
// might ever configure would admit it on its own, so the exemption is dead
// weight and must be deleted.
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
 * How old an excluded version may get before its exclusion must be deleted.
 *
 * 30 days is deliberately far above any plausible `minimumReleaseAge` floor
 * (pnpm's own default when enabled is 1440 minutes — one day), so the guard
 * never fires while an exemption could still be load-bearing. It only fires once
 * the entry is provably inert.
 */
export const MAX_EXCLUSION_AGE_DAYS = 30;

/** Repo-relative path of the committed publish-date ledger. */
export const EXCLUSION_LEDGER_PATH = 'scripts/minimum-release-age-exclusions.json';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `name@version` with an EXACT version. Ranges, globs and bare package names are
 * rejected by design — see readExclusionEntries().
 */
const EXCLUSION_ENTRY_RE =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)*$/;

/** The UTC timestamp shape npm's registry `time` map uses, copied verbatim. */
const PUBLISHED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

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

  // NO SILENT FALLBACK: a POPULATED flow form (`minimumReleaseAgeExclude:
  // ['a@1.0.0']`) does not match the block-header regex below, so it would parse
  // as "no exclusions" and every entry inside it would escape the expiry rule.
  // The EMPTY flow form is accepted precisely because nothing can hide in it —
  // and it is what this repo writes in the steady state, so the key stays
  // visible (with its policy comment) instead of vanishing whenever the list
  // empties out.
  const header = lines.find((line) => /^minimumReleaseAgeExclude:/.test(line));
  if (header !== undefined && /^minimumReleaseAgeExclude:\s*\[\s*\]\s*$/.test(header)) {
    return [];
  }
  if (header !== undefined && !/^minimumReleaseAgeExclude:\s*$/.test(header)) {
    throw new Error(
      'verify-minimum-release-age-exclusions.mjs found a non-block minimumReleaseAgeExclude declaration in ' +
        `pnpm-workspace.yaml:\n  ${header}\n` +
        'Only the block-sequence form (`minimumReleaseAgeExclude:` followed by indented `- name@version` items) ' +
        'and the empty flow sequence (`minimumReleaseAgeExclude: []`) are supported. A populated inline flow ' +
        'sequence would parse as an empty list and silently exempt every entry inside it from the expiry rule.'
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
    if (/^\S/.test(rawLine)) {
      break; // next top-level key ends the block
    }
    const item = rawLine.match(/^\s+-\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*$/);
    if (!item) {
      // NO SILENT FALLBACK: an unparsed line inside the block would drop an
      // exclusion from the checked set and fake a green for it.
      throw new Error(
        'verify-minimum-release-age-exclusions.mjs could not parse this line inside the pnpm-workspace.yaml ' +
          `minimumReleaseAgeExclude: block:\n  ${rawLine}\n` +
          'Only simple `- name@version` list items (optionally quoted) are supported. Teach ' +
          'readExclusionEntries() the new shape rather than letting the entry escape the guard.'
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
  if (typeof record.publishedAt !== 'string' || !PUBLISHED_AT_RE.test(record.publishedAt)) {
    throw new Error(
      `${EXCLUSION_LEDGER_PATH} record for "${entry}" has publishedAt ${JSON.stringify(record.publishedAt)}, ` +
        'which is not a UTC ISO-8601 timestamp (e.g. "2026-07-06T17:29:36.461Z"). Copy the value verbatim from ' +
        `the npm registry metadata: \`curl -s https://registry.npmjs.org/<name> | jq '.time["<version>"]'\`.`
    );
  }
  if (typeof record.reason !== 'string' || record.reason.trim() === '') {
    throw new Error(
      `${EXCLUSION_LEDGER_PATH} record for "${entry}" has no "reason". An exclusion whose justification is not ` +
        'written down cannot be re-decided by the next reader; state what this specific version was needed for.'
    );
  }
}

/** Whole days elapsed between `publishedAt` and `now`, as a fractional number. */
export function exclusionAgeDays(publishedAt, now) {
  return (now.getTime() - Date.parse(publishedAt)) / MS_PER_DAY;
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
 * @param {{ repoRoot: string, now?: Date }} options
 */
export function findExclusionProblems({ repoRoot, now = new Date() }) {
  const entries = readExclusionEntries(repoRoot);
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
    if (ageDays > MAX_EXCLUSION_AGE_DAYS) {
      problems.push({ ageDays, entry, kind: 'expired', record });
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
      `past the ${MAX_EXCLUSION_AGE_DAYS}-day limit. The exception has served its purpose (recorded reason: ` +
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
  const problems = findExclusionProblems({ now, repoRoot });

  if (problems.length === 0) {
    const count = readExclusionEntries(repoRoot).length;
    console.log(
      `verify-minimum-release-age-exclusions: OK (${count} minimumReleaseAgeExclude entr${count === 1 ? 'y' : 'ies'}` +
        `, none older than ${MAX_EXCLUSION_AGE_DAYS} days)`
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
