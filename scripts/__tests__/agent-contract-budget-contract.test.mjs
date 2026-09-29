import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACT_DIR = 'docs/agents';

/**
 * Derived, never registered: an evidence area is any `docs/agents/<area>/`
 * directory whose `<area>.md` contract exists. A hand-maintained list would be
 * a second source of truth, would conflict on every PR that converts another
 * contract, and would silently leave a new area unguarded until someone
 * remembered to add it.
 */
const evidenceDirs = () =>
  readdirSync(path.join(repoRoot, CONTRACT_DIR), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        statSync(path.join(repoRoot, CONTRACT_DIR, `${entry.name}.md`), {
          throwIfNoEntry: false,
        })?.isFile() === true
    )
    .map((entry) => entry.name)
    .sort();

/**
 * `_`-prefixed docs are generated or periodically regenerated audit artifacts
 * (`_freshness-report.md`), not contracts an agent reads before a change. An
 * exact pin on a regenerated report fails on regeneration with advice its
 * author cannot act on, and "shrink-only" is meaningless for one.
 */
const isContractDoc = (name) => name.endsWith('.md') && !name.startsWith('_');

/**
 * SHRINK-ONLY CONTRACT BUDGETS — same shape as the file budget in
 * docs/agents/ci-quality.md § "SHRINK-ONLY FILE BUDGETS"; do not turn it into a
 * cap with headroom.
 *
 * An agent reads a whole contract before touching its area, so every line is
 * paid for on every task. Each number is the file's CURRENT line count, never an
 * allowance. Growth fails: move the material to an evidence file
 * (`docs/agents/<area>/<topic>.md`, exempt from this budget) per
 * docs/agents/README.md. The budget is an EXACT pin, not a ceiling: shrinking
 * below it fails too, so the number is lowered in the same commit. A tolerance
 * band would let a contract shed a few lines without re-baselining and a later
 * change add them back while still passing.
 */
const CONTRACT_LINE_BUDGETS = {
  'agent-self-query.md': 305,
  'assistant-persistence.md': 2016,
  // BST-1794 raised this from 2312, the first upward move since the budgets
  // were introduced — taking docs/agents/README.md's sanctioned path for a
  // contract that "legitimately must grow (a genuinely new subsystem area)":
  // catalog-default policies needed four rules an agent must obey before
  // adding a model migration, notably that catalog upserts must never write
  // `models.updated_at`, which silently makes rows unreachable.
  //
  // Everything movable went to the evidence file (112 lines). The
  // `is_enabled` subsection was compressed 21 -> 17 lines in fa6867632, then
  // 17 -> 16 in the follow-up review pass that folded two bullets and added
  // the `models.updated_at` guard's citation; the OpenRouter and Bedrock
  // enablement bullets were consolidated into cross-references. Net against
  // the doc across both commits: 2312 -> 2324 (+12). 16 is the floor actually
  // reached, not claimed irreducible — a later pass may compress it further.
  //
  // NOT a precedent for open-ended growth: the shrink-only doctrine below
  // still holds. One real, unresolved tension worth recording: README
  // sanctions re-baselining for cases like this one, while this test's own
  // failure message says "do not raise the number" — both are true at once,
  // and this pin does not decide which wins next time.
  //
  // BST-1804 raised this from 2323 (+5): the OpenRouter top_provider
  // context-window rule was promoted from evidence into the pricing section.
  // It then rose to 2336 (+8) when the review found the rule unenforced:
  // the rule now names its null-only fallback and the audit that enforces it.
  // Then 2338 (+2): the visibility hard rule states why always-on Anthropic
  // rows send `thinking` at Auto.
  'assistant-providers.md': 2338,
  'assistant-runtime.md': 2780,
  'assistant-subagents.md': 1626,
  'changeset-diff.md': 495,
  'ci-quality.md': 924,
  'code-execution.md': 364,
  // BST-1794 raised this from 852: rule 3 (catalog upsert) needed a
  // sibling-invariant cross-reference to the `models.updated_at` rule in
  // assistant-providers.md, so a migration author meets it where they
  // actually read rather than only in the provider contract.
  //
  // BST-1221 raised it from 855 (+19): PGlite is now vendored with a patch that
  // changes its failure semantics — a WebAssembly trap throws and poisons the
  // instance instead of spinning a blocked event loop forever. An agent on any
  // PGlite path must know that before it reads a stack trace or touches the
  // patch, so the rule belongs in the contract, not only in evidence. The story
  // (the trace, the upstream issues, what the patch deliberately does not do,
  // and when it is dropped) went to `database/pglite-fatal-trap.md`, 59 lines;
  // what stayed is 18 lines of rule plus a one-line correction to the close
  // bullet, whose "SIGKILL is the only exit" is no longer true of a trap.
  //
  // BST-1876 raised it from 874 (+21): the TABLE DURABILITY CLASSES section is
  // a new area, not growth of an existing one. Automated repair, snapshot
  // verification and portable export all obey these class rules, and an agent
  // adding a table must classify it in the same change. The per-table reasoning
  // went to `database/table-durability-classes.md`.
  // BST-1871 raised it from 895 (+2): one bullet names the crash-sensitive index AM list.
  // BST-1873 raised it from 897 (+11): DESKTOP DATABASE LOCATION is a new
  // area, not growth of an existing section. Packaged builds now resolve their
  // database from `app.isPackaged` (never NODE_ENV) and per-OS data folders,
  // main resolves once and the DB host reads only its environment; an agent
  // changing a location, the precedence or the host handoff must meet those
  // rules first. The incident, the vendor citations and the open points went
  // to `database/desktop-database-location.md`.
  // BST-1870 L2b raised it from 908 (+10): the integrity-containment
  // background pause is a new scheduler rule with its guards. L4 rewrote the
  // maintenance bullet in place, so the count is unchanged.
  'database.md': 918,
  'domain.md': 37,
  // A new contract that grows with each ADR-0004 phase; each addition is a
  // rule with its guard, and the record lives in effect-boundary/*.md.
  'effect-boundary.md': 105,
  'explorer-search-tapestry.md': 638,
  'issue-tracker.md': 56,
  'local-inference.md': 403,
  'mastra-boundary.md': 402,
  'mcp-conformance.md': 199,
  // BST-1870 L1 raised this from 955 (+3): the boot/migration never-reset rule; the L4
  // change replaces this whole section and re-pins to its exact new count.
  // BST-1873 raised this from 958 (+3): the factory-reset userData bullet now
  // states that the database root is inside userData only in test runs and on
  // packaged macOS, and that reset deletes the profile before any wipe.
  // BST-1872 L1 raised it by 4 more, to 965: the awaited-close / SIGKILL-wedge / no-fork rule
  // and "an exit code is never proof of a clean close"; L2 replaces the shutdown-ownership
  // first bullet and re-pins. The L1 review round added 1 more, to 966: only an observed exit
  // proves a departed DB host gone, so nothing forks or reports a close before it. Round 2
  // added 1 more, to 967: a repeated close resolves once that exit is observed (the absent
  // marker makes the next open unclean).
  // BST-1872 L1b (the fail-closed close, the clean-shutdown marker proof, the sticky close
  // failure and its round-2 fixes) adds the rest of the DB host bullet, to 971.
  // BST-1870 L4 replaced the runtime-recovery section with DATABASE INTEGRITY CONTAINMENT
  // (the recovery order and its history moved to evidence), a net -4 lines.
  // BST-1870 L4b: the Guard line names the containment E2E, one more line.
  // BST-1872 L2a added 6, to 974: the DB host closes itself on SIGINT/SIGTERM/SIGHUP (a failed
  // close exits 1 with no marker and no retry); main forks no replacement for a host whose close
  // was announced or proven by the marker, and a lost announcement is named as the known gap.
  // BST-1872 L2b added 8 more, to 982: the shutdown-ownership first bullet names the reserved
  // database-close slice (+1) and main's persistent signal listeners installed after ready (+7,
  // with why a listener added earlier never runs).
  'platform-contracts.md': 982,
  'README.md': 70,
  'triage-labels.md': 35,
  // BST-1805 raised this from 608: the FLOATING LAYER STACKING table gained a
  // row for `STICKY_SECTION_HEADER_LAYER_CLASS`. The table IS the scale, so a
  // new token cannot live in an evidence file without the scale going stale.
  // It then rose to 615: § Scroll ownership names the Model Catalog as the
  // second sanctioned shared-scroller consumer, next to the rule it applies.
  // BST-1837 raised it from 612 to 652: § TAB STRIPS is a new subsystem area
  // (the shared TabStrip primitives every document strip renders), not growth
  // of an existing section; its record lives in ui-conventions/tab-strips.md.
  //
  // BST-1841 raised it by 30 more, to 682: the new VIEW SWITCHERS (Tabs)
  // section is a new area — one `Tabs` idiom for every fixed switcher — whose
  // rules (sizes, manual activation, `TabsContent` visibility, transitions only
  // for React state) an agent must meet before touching any switcher. Each
  // "Why" is one clause; the detail lives in `packages/ui/src/tabs.tsx` comments.
  //
  // BST-1850 raised it from 682 to 705 (+23): the new APP RELOAD section is a new
  // area, not growth of TAB STRIPS. It is the gate every renderer entry mounts,
  // and an agent that adds an entry, a reload trigger or a build must meet its
  // rules first: the reload is always the user's click, an unreadable run count
  // is UNKNOWN and never zero, and the marker is written before the reload. The
  // research, the capability citation and the known limits went to
  // ui-conventions/app-reload.md.
  'ui-conventions.md': 705,
  'workspace-context.md': 1071,
};

/**
 * Line counts are `source.split('\n').length`, matching the app-shell precedent:
 * that is one MORE than `wc -l` for a newline-terminated file. Lowering a budget
 * by hand means using this number, not `wc -l`.
 *
 * Returns the failure message, or null when the count matches the budget.
 */
function checkShrinkOnlyBudget(label, lineCount, budget) {
  if (lineCount > budget) {
    return (
      `${label} grew to ${lineCount} lines, past its shrink-only budget of ${budget}. ` +
      'Move the new material to an evidence file (docs/agents/README.md); do not raise the number.'
    );
  }
  if (lineCount < budget) {
    return (
      `${label} shrank to ${lineCount} lines. Lower its budget from ${budget} to ${lineCount} ` +
      'in this commit so the recovered headroom cannot be spent later.'
    );
  }
  return null;
}

const contractFiles = readdirSync(path.join(repoRoot, CONTRACT_DIR), { withFileTypes: true })
  .filter((entry) => entry.isFile() && isContractDoc(entry.name))
  .map((entry) => entry.name)
  .sort();

test('every contract doc in docs/agents is registered with a line budget', () => {
  assert.deepEqual(contractFiles, Object.keys(CONTRACT_LINE_BUDGETS).sort());
});

test('agent contracts stay inside their shrink-only line budgets', () => {
  const failures = contractFiles
    .filter((name) => Object.hasOwn(CONTRACT_LINE_BUDGETS, name))
    .map((name) => {
      const source = readFileSync(path.join(repoRoot, CONTRACT_DIR, name), 'utf8');
      return checkShrinkOnlyBudget(
        `${CONTRACT_DIR}/${name}`,
        source.split('\n').length,
        CONTRACT_LINE_BUDGETS[name]
      );
    })
    .filter((failure) => failure !== null);
  assert.deepEqual(failures, []);
});

/** Citations are prose-wrapped across lines; compare on collapsed whitespace. */
const flatten = (text) => text.replace(/\s+/gu, ' ').trim();

/**
 * Anchored, not a substring test: a citation must name the WHOLE heading, or
 * the whole heading minus a trailing parenthetical (a ticket id, a filename, a
 * settled-on date). A substring test would let § "Coverage" satisfy
 * "Coverage is a separate workflow", which is the mis-citation worth catching.
 */
const citesHeading = (heading, wanted) =>
  heading === wanted || (heading.startsWith(`${wanted} (`) && heading.endsWith(')'));

test('every evidence file names a section its contract actually has', () => {
  const failures = [];
  for (const area of evidenceDirs()) {
    const contract = readFileSync(path.join(repoRoot, CONTRACT_DIR, `${area}.md`), 'utf8');
    const headings = contract
      .split('\n')
      .filter((line) => /^#{2,4} /.test(line))
      .map((line) => flatten(line.replace(/^#+ /, '')));
    for (const name of readdirSync(path.join(repoRoot, CONTRACT_DIR, area)).sort()) {
      const file = `${area}/${name}`;
      const source = readFileSync(path.join(repoRoot, CONTRACT_DIR, file), 'utf8');
      // \s*, not a literal space: a citation may wrap between § and the quoted
      // heading. Where markdown breaks the line is not a contract change.
      const cited = source.match(/§\s*"([^"]+)"/u);
      if (!cited) {
        failures.push(`${file} does not cite the contract section it supports (§ "<heading>")`);
        continue;
      }
      const wanted = flatten(cited[1]);
      if (!headings.some((heading) => citesHeading(heading, wanted))) {
        failures.push(`${file} cites § "${wanted}", which is not a heading in ${area}.md`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

/**
 * isFile, not exists: `existsSync` accepts a directory, so a directory named
 * `<topic>.md` would count as resolved while pointing at nothing readable.
 * `throwIfNoEntry: false` keeps a missing target a reported failure rather than
 * a throw, while a permission error stays loud.
 */
const pointerResolves = (target) => statSync(target, { throwIfNoEntry: false })?.isFile() === true;

test('every evidence pointer in a contract resolves to a file', () => {
  const failures = [];
  for (const name of contractFiles) {
    const source = readFileSync(path.join(repoRoot, CONTRACT_DIR, name), 'utf8');
    // Only `<area>/<topic>.md` pointers, so repo-root paths like `docs/x.md`
    // elsewhere in a contract are not mistaken for evidence references.
    const pointers = new RegExp(
      String.raw`\x60((?:${evidenceDirs().join('|')})/[a-z0-9-]+\.md)\x60`,
      'gu'
    );
    for (const [, pointer] of source.matchAll(pointers)) {
      if (!pointerResolves(path.join(repoRoot, CONTRACT_DIR, pointer))) {
        failures.push(`${name} points at ${pointer}, which is not a readable file`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('every evidence file is referenced by its contract', () => {
  const failures = [];
  for (const area of evidenceDirs()) {
    const contract = readFileSync(path.join(repoRoot, CONTRACT_DIR, `${area}.md`), 'utf8');
    for (const name of readdirSync(path.join(repoRoot, CONTRACT_DIR, area)).sort()) {
      if (!contract.includes(`${area}/${name}`)) {
        failures.push(`${area}/${name} is not reachable: ${area}.md never points at it`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('a pointer resolves only to a readable regular file', () => {
  // Discovered, not hard-coded: areas are derived and sorted, so naming a
  // specific area's specific file makes this test fail the next time a
  // contract is converted ahead of it alphabetically.
  const area = path.join(repoRoot, CONTRACT_DIR, evidenceDirs()[0]);
  const present = readdirSync(area).sort()[0];
  assert.equal(pointerResolves(path.join(area, present)), true);
  assert.equal(pointerResolves(path.join(area, 'does-not-exist.md')), false);
  // The directory itself: what a revert to existsSync would wrongly accept.
  assert.equal(pointerResolves(area), false);
});

test('a citation must name the whole heading, not a fragment', () => {
  assert.equal(citesHeading('Workload boundaries', 'Workload boundaries'), true);
  assert.equal(citesHeading('Workload boundaries (BST-1)', 'Workload boundaries'), true);
  assert.equal(citesHeading('Coverage is a separate workflow', 'Coverage'), false);
  assert.equal(citesHeading('Workload boundaries extended', 'Workload boundaries'), false);
});

test('the budget can fail in both directions', () => {
  assert.equal(checkShrinkOnlyBudget('doc', 100, 100), null);
  assert.match(checkShrinkOnlyBudget('doc', 101, 100), /grew to 101 lines/);
  assert.match(checkShrinkOnlyBudget('doc', 99, 100), /Lower its budget from 100 to 99/);
});
