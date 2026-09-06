#!/usr/bin/env node
/**
 * `turbo boundaries`, scoped to source files (follow-up to BST-967).
 *
 * WHY THIS WRAPPER EXISTS. The analyzer walks every package directory and its
 * ONLY exclusion is `node_modules/**` — it reads `dist/` and every other
 * emitted output, and it does not consult `.gitignore`. So the gate is not
 * idempotent on a developer machine: `pnpm check` passes on a clean tree, then
 * fails on the identical tree once a build has run, with findings against
 * generated bundles instead of source (`apps/web/dist/assets/chunking.worker-*.ts`
 * "cannot import package @brainstrike/tokenization" — a Vite chunk, not code
 * anyone wrote). Verified against turbo 2.10.8, 2.10.10, and 2.10.11-canary.3:
 * there is no CLI flag, no `turbo.json` key, and no `.turboignore` that
 * narrows the walk, and `--ignore` only offers to WRITE `@boundaries-ignore`
 * comments into the scanned files — useless for output that is regenerated on
 * every build. Recheck on the next Turbo bump: the day the walk can be
 * narrowed, this wrapper should shrink to that config.
 *
 * TWO SHAPES OF TURBO'S OUTPUT ARE LOAD-BEARING, so recheck them on that bump
 * too. First, the streams are split: the `Checked N files … K issues found`
 * summary arrives on stdout while the diagnostics arrive on stderr, and this
 * only filters when the two agree. If turbo moves the summary to stderr, every
 * run takes the mismatch branch and the gate degrades to "print everything,
 * exit 1" — non-idempotent again, but loudly and with an explanation, which is
 * the correct direction to fail. Second, each boundaries diagnostic carries ONE
 * file location today; `partitionFindings` requires EVERY location in a finding
 * to be ignored, so a future turbo that adds a second span (a package.json
 * snippet beside the offending import, say) would turn generated findings back
 * into source findings. Both failures are loud, and the parser test pins the
 * current shape.
 *
 * WHAT IT DOES. Runs the real command, then judges only findings in files that
 * are part of the repository. "Generated" is not a hardcoded directory list —
 * a list would drift (and turbo's own `outputs` cannot serve as one: this repo
 * declares `tsconfig/**`, `biome/**`, and `tailwind/**` as build outputs of
 * packages/config, and those are SOURCE). The rule is `git check-ignore`: a
 * file git ignores is not source. That call is index-aware, so a checked-in
 * file is never classified as generated even when it matches an ignore
 * pattern, and an untracked-but-not-ignored file — a source file you have not
 * committed yet — is still judged.
 *
 * NO SILENT FALLBACKS. Suppression only ever applies to a finding whose file
 * git confirms is ignored. Everything else fails the gate:
 *   - turbo's own issue count not matching the diagnostics parsed here (the
 *     parser has fallen behind turbo's output format),
 *   - a diagnostic with no file location,
 *   - `git check-ignore` erroring, or no git repository to ask.
 * Failing loudly on a parse mismatch is the point: a filter that silently
 * matches nothing would turn this gate green forever.
 *
 * Local-vs-CI difference, stated rather than hidden: a developer's personal
 * excludes (`~/.config/git/ignore`, `.git/info/exclude`) count as ignored
 * here. CI's checkout has neither, so CI remains the stricter of the two.
 *
 * Ordering note: Static still runs this first, before anything that
 * materializes `dist/`. That is now a COST property (a clean tree is ~4,000
 * files to scan instead of ~8,000), not a correctness one.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// turbo's own Node entry point, not `node_modules/.bin/turbo`: on Windows the
// bin shim is a `.cmd`, which Node refuses to spawn without `shell: true`, and
// a shell would have to quote a REPO_ROOT that may contain spaces.
const TURBO_ENTRY = path.join(REPO_ROOT, 'node_modules', 'turbo', 'bin', 'turbo');

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are precisely what this strips out of turbo's output
const ANSI_PATTERN = /\[[0-9;]*m/g;

/** Start of a miette diagnostic block in turbo's stderr: two spaces, `x`, space. */
const DIAGNOSTIC_START = /^ {2}[x×] /m;

/** A miette source-location header: `,-[/abs/path/file.ts:12:34]`. */
const LOCATION_PATTERN = /,-\[(.+?):\d+:\d+\]/g;

/** turbo's stdout summary, e.g. `Checked 8053 files in 49 packages, 4 issues found`. */
const SUMMARY_PATTERN =
  /Checked (\d+) files? in (\d+) packages?, (?:(\d+) issues? found|no issues found)/;

function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Splits turbo's stderr into the prelude (`• turbo 2.10.8`) and one entry per
 * diagnostic, each with the file paths it points at.
 *
 * @param {string} stderr raw stderr from `turbo boundaries`
 * @returns {{ prelude: string, findings: { paths: string[], text: string }[] }}
 */
export function parseFindings(stderr) {
  const clean = stripAnsi(stderr);
  const firstDiagnostic = clean.search(DIAGNOSTIC_START);
  if (firstDiagnostic === -1) {
    return { findings: [], prelude: clean };
  }
  const prelude = clean.slice(0, firstDiagnostic);
  const findings = clean
    .slice(firstDiagnostic)
    .split(DIAGNOSTIC_START)
    // `split` on a lookahead-free pattern drops the `  x ` marker itself, and
    // the leading empty element before the first match.
    .filter((block) => block.trim().length > 0)
    .map((block) => ({
      paths: [...`  x ${block}`.matchAll(LOCATION_PATTERN)].map((match) => match[1]),
      text: `  x ${block}`.trimEnd(),
    }));
  return { findings, prelude };
}

/** @returns {number | null} the issue count turbo reported, or null if absent */
export function parseIssueCount(stdout) {
  const match = stripAnsi(stdout).match(SUMMARY_PATTERN);
  if (!match) {
    return null;
  }
  return match[3] === undefined ? 0 : Number(match[3]);
}

/**
 * @param {string[]} paths file paths to classify
 * @param {string} cwd workspace root to ask git from
 * @returns {Set<string>} the subset git ignores (i.e. generated, not source)
 * @throws if git cannot answer — an unanswerable question is never a pass
 */
export function gitIgnoredPaths(paths, cwd = process.cwd()) {
  if (paths.length === 0) {
    return new Set();
  }
  const result = spawnSync('git', ['check-ignore', '--stdin', '-z'], {
    cwd,
    encoding: 'utf8',
    input: `${paths.join('\0')}\0`,
    maxBuffer: 64 * 1024 * 1024,
  });
  // ORDER IS LOAD-BEARING (BST-1376). `git check-ignore` exits immediately when
  // cwd is not a repository — before reading a byte of stdin — so the path list
  // above lands on a pipe whose reader is gone. `spawnSync` surfaces that as
  // `error: EPIPE` while STILL reporting the child's real exit status, and
  // reading `error` first threw that status away to blame the spawn ("could not
  // run git check-ignore") for a git that ran and answered. Whether the write
  // loses the race depends on payload size and scheduling, which is why the
  // no-repository case classified fine on developer machines and failed in CI.
  // A null status is the only state in which nothing ran.
  if (result.status === null) {
    throw new Error(`could not run git check-ignore: ${result.error?.message ?? 'no exit status'}`);
  }
  // 0 = some paths are ignored, 1 = none are. Anything else (128: not a git
  // repository, bad path) means the classification is unknown.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git check-ignore failed (exit ${result.status}): ${result.stderr.trim() || 'no output'}`
    );
  }
  // git answered, but only about as much of the list as it received. A verdict
  // over an unknown subset cannot classify anything: suppression may only ever
  // rest on a path git actually confirmed, so this is never a partial pass.
  if (result.error) {
    throw new Error(
      `git check-ignore was given an incomplete path list (${result.error.message}); ` +
        'its answer covers an unknown subset of the findings and cannot be trusted'
    );
  }
  return new Set(result.stdout.split('\0').filter(Boolean));
}

/**
 * Splits findings into the ones the gate must report and the ones that point
 * only at generated files. A finding with no location is never suppressed.
 *
 * @param {{ paths: string[], text: string }[]} findings
 * @param {Set<string>} ignored
 */
export function partitionFindings(findings, ignored) {
  const source = [];
  const generated = [];
  for (const finding of findings) {
    const isGenerated =
      finding.paths.length > 0 && finding.paths.every((file) => ignored.has(file));
    (isGenerated ? generated : source).push(finding);
  }
  return { generated, source };
}

export function main(argv = [], { cwd = process.cwd() } = {}) {
  const turbo = spawnSync(process.execPath, [TURBO_ENTRY, 'boundaries', ...argv], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (turbo.error) {
    throw new Error(`could not run ${TURBO_ENTRY}: ${turbo.error.message}`);
  }

  const issueCount = parseIssueCount(turbo.stdout);
  if (issueCount === 0 || (issueCount === null && turbo.status === 0)) {
    process.stdout.write(turbo.stdout);
    process.stderr.write(turbo.stderr);
    return turbo.status ?? 1;
  }

  const { findings, prelude } = parseFindings(turbo.stderr);
  if (issueCount === null || findings.length !== issueCount) {
    process.stdout.write(turbo.stdout);
    process.stderr.write(turbo.stderr);
    console.error(
      `\n${path.basename(fileURLToPath(import.meta.url))}: could not account for turbo's output ` +
        `(reported ${issueCount ?? 'no'} issues, parsed ${findings.length} diagnostics). ` +
        'Reporting every finding unfiltered — fix the parser in scripts/turbo-boundaries.mjs.'
    );
    return turbo.status === 0 ? 1 : (turbo.status ?? 1);
  }

  // A git that cannot answer leaves every finding unclassifiable, so it fails —
  // but it fails the same way the parse mismatch above does, handing back the
  // full unfiltered output. Throwing here instead would print only the git
  // error and drop the diagnostics the developer has to act on (worst in the
  // plausible no-repository case: a tarball export, where it would read as
  // tooling breakage rather than N boundary findings nobody can classify).
  let ignored;
  try {
    ignored = gitIgnoredPaths([...new Set(findings.flatMap((finding) => finding.paths))], cwd);
  } catch (error) {
    process.stdout.write(turbo.stdout);
    process.stderr.write(turbo.stderr);
    console.error(
      `\n${path.basename(fileURLToPath(import.meta.url))}: ${error instanceof Error ? error.message : String(error)}. ` +
        `Reporting all ${findings.length} findings unfiltered — none of them could be classified as source or generated.`
    );
    return 1;
  }
  const { generated, source } = partitionFindings(findings, ignored);

  process.stdout.write(turbo.stdout);
  if (source.length > 0) {
    process.stderr.write(prelude);
    process.stderr.write(`${source.map((finding) => finding.text).join('\n\n')}\n`);
  }
  if (generated.length > 0) {
    console.log(
      `Ignored ${generated.length} finding${generated.length === 1 ? '' : 's'} in generated ` +
        'output (files git ignores are not source; `pnpm clean` removes them).'
    );
  }
  console.log(
    source.length === 0
      ? 'No source boundary violations.'
      : `${source.length} source boundary violation${source.length === 1 ? '' : 's'}.`
  );
  return source.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
