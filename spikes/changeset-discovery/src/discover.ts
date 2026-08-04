import { buildInventory } from './inventory.ts';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  // biome-ignore lint/suspicious/noConsole: CLI usage message is the intended output channel
  console.error('usage: node src/discover.ts <rootPath> [<rootPath>...]');
  process.exit(1);
}
const inv = await buildInventory(roots);
// biome-ignore lint/suspicious/noConsole: CLI's JSON result is the intended stdout output
console.log(JSON.stringify(inv, null, 2));
// biome-ignore lint/suspicious/noConsole: CLI summary line is the intended stderr output
console.error(
  `repos=${inv.repos.length} worktrees=${inv.repos.reduce((n, r) => n + r.worktrees.length, 0)} ` +
    `walk=${inv.timingMs.walk.toFixed(0)}ms enumerate=${inv.timingMs.enumerate.toFixed(0)}ms ` +
    `total=${inv.timingMs.total.toFixed(0)}ms errors=${inv.errors.length}`
);
