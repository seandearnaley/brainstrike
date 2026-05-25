/**
 * Writes docs/dependency-version-updates-report.md from `pnpm outdated -r --json`.
 * Run from repo root: node scripts/generate-dependency-update-report.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function runOutdatedJson() {
  const result = spawnSync('pnpm', ['outdated', '-r', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  // `pnpm outdated` exits non-zero when packages are outdated (status 1) AND on real failures.
  // Distinguish "found outdated packages" (stdout has JSON) from "command failed" (no JSON, e.g. registry/auth/network).
  const stdout = result.stdout ?? '';
  // pnpm may print WARN lines to stdout before JSON; those lines can contain `{` inside engine JSON.
  const start = stdout.indexOf('{\n  "') === -1 ? stdout.indexOf('{"') : stdout.indexOf('{\n  "');
  if (start === -1) {
    const stderr = (result.stderr ?? '').trim();
    const reason = stderr || `exit ${result.status ?? 'unknown'}`;
    throw new Error(`pnpm outdated did not return JSON (${reason})`);
  }
  return JSON.parse(stdout.slice(start));
}

function workspacePackages() {
  const out = [];
  const rootPkgPath = path.join(root, 'package.json');
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
  out.push({
    path: '.',
    name: rootPkg.name ?? 'root',
    version: rootPkg.version ?? '',
    private: Boolean(rootPkg.private),
  });
  for (const top of ['apps', 'packages']) {
    const topDir = path.join(root, top);
    if (!fs.existsSync(topDir)) {
      continue;
    }
    for (const ent of fs.readdirSync(topDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) {
        continue;
      }
      const pkgPath = path.join(topDir, ent.name, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        continue;
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      out.push({
        path: path.join(top, ent.name),
        name: pkg.name ?? '(unnamed)',
        version: pkg.version ?? '',
        private: Boolean(pkg.private),
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function bumpKind(current, latest) {
  if (!(current && latest) || current === latest) {
    return '—';
  }
  try {
    return semver.diff(current, latest) ?? 'prerelease';
  } catch {
    return 'non-semver';
  }
}

function main() {
  const data = runOutdatedJson();
  const rows = [];
  for (const [name, info] of Object.entries(data)) {
    const { current, latest, wanted, isDeprecated, dependencyType, dependentPackages } = info;
    const outdated = current !== latest;
    const deps = [...new Set(dependentPackages.map((p) => p.name))].sort();
    rows.push({
      name,
      current,
      wanted,
      latest,
      bump: bumpKind(current, latest),
      outdated,
      isDeprecated: Boolean(isDeprecated),
      dependencyType,
      dependents: deps,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  const outdatedRows = rows.filter((r) => r.outdated || r.isDeprecated);
  const upToDate = rows.filter((r) => !(r.outdated || r.isDeprecated));

  const date = new Date().toISOString().slice(0, 10);
  let md = '';
  md += '# Dependency version update report\n\n';
  md += `**Generated:** ${date}  \n`;
  md += '**Monorepo:** brainstrike (pnpm workspaces + Turborepo)  \n';
  md += '**Tooling:** `pnpm@10.33.0` (see root `package.json` `packageManager`)  \n';
  md += '**Node engine (declared):** `24.x` (root `package.json` `engines`)  \n\n';

  md += '## Methodology\n\n';
  md +=
    '- Command: `pnpm outdated -r --json` from the repository root (recursive across all workspace packages).\n';
  md +=
    '- This compares **direct** dependencies declared in each workspace `package.json` to the **registry latest**; it does not enumerate the full transitive tree.\n';
  md +=
    '- Regenerate: `node scripts/generate-dependency-update-report.mjs` (after `pnpm install`).\n\n';

  const workspaces = workspacePackages();
  md += '## Workspace packages (pnpm / Turborepo)\n\n';
  md +=
    'Workspaces follow root `package.json` `workspaces`: `apps/*`, `packages/*` (one level under each).\n\n';
  md += '| Package name | Path | Version | Private |\n';
  md += '| --- | --- | --- | --- |\n';
  for (const w of workspaces) {
    md += `| \`${w.name}\` | \`${w.path}\` | ${w.version || '—'} | ${w.private ? 'yes' : 'no'} |\n`;
  }
  md += '\n';

  md += '## How to read this document\n\n';
  md +=
    '- **Current:** version resolved in the lockfile for the listed dependents (aggregated across workspaces).\n';
  md +=
    '- **Wanted:** maximum version allowed by the semver range in each declaring `package.json` (may differ per workspace; pnpm lists dependents).\n';
  md += '- **Latest:** newest version published to the registry when this report was generated.\n';
  md +=
    '- **Bump (current → latest):** `major` / `minor` / `patch` via semver (or `non-semver` for non-standard tags).\n';
  md +=
    '- Packages where **current === latest** are omitted from the “Outdated” table unless **deprecated**.\n\n';

  md += '## Summary\n\n';
  md += '| Metric | Count |\n| --- | ---: |\n';
  md += `| Distinct direct dependencies checked (\`pnpm outdated -r\`) | ${rows.length} |\n`;
  md += `| Outdated (current ≠ latest) or deprecated | ${outdatedRows.length} |\n`;
  md += `| Up to date (current === latest, not deprecated) | ${upToDate.length} |\n\n`;

  md += '## Outdated or deprecated packages\n\n';
  md += '| Package | Current | Wanted | Latest | Bump | Type | Deprecated | Dependents |\n';
  md += '| --- | --- | --- | --- | --- | --- | --- | --- |\n';
  for (const r of outdatedRows) {
    const depList = r.dependents.join(', ');
    md += `| \`${r.name}\` | ${r.current} | ${r.wanted} | ${r.latest} | ${r.bump} | ${r.dependencyType} | ${r.isDeprecated ? 'yes' : 'no'} | ${depList} |\n`;
  }

  md += '\n## Up to date (not listed above)\n\n';
  md += 'These packages had **current === latest** and were **not** marked deprecated:\n\n';
  md += upToDate.map((r) => `- \`${r.name}\` @ ${r.current}`).join('\n');
  md += '\n';

  md += '\n## Related\n\n';
  md +=
    '- [`dependency-updates-breaking-changes.md`](./dependency-updates-breaking-changes.md) — migration notes and changelog pointers for high-risk upgrades.\n';

  const outPath = path.join(root, 'docs', 'dependency-version-updates-report.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`Wrote ${outPath}`);
}

main();
