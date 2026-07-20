#!/usr/bin/env node
// BST-578: drizzle-kit generate is a footgun in this repo. The drizzle
// snapshot is DELIBERATELY drifted from the schema — see the three
// "SNAPSHOT DRIFT (intentional)" sentries in packages/db/src/schema/index.ts
// and docs/agents/database.md (dual-runner migration architecture).
// Running generate emits a spurious diff migration that must not land.
process.stderr.write(
  [
    'BLOCKED: drizzle-kit generate is disabled in this repo.',
    '',
    'The drizzle snapshot is deliberately drifted — see the "SNAPSHOT DRIFT',
    '(intentional)" sentries in packages/db/src/schema/index.ts and',
    'docs/agents/database.md. Migrations are hand-written and registered in',
    'BOTH runners (numbered + drizzle customMigrations).',
    '',
    'If you are absolutely sure (e.g. inspecting the drift itself), use:',
    '  pnpm db:generate:unsafe',
    '',
  ].join('\n')
);
process.exit(1);
