#!/usr/bin/env node
// BST-578: drizzle-kit generate is a footgun in this repo. The drizzle
// snapshot is DELIBERATELY drifted from the schema — see the four
// "SNAPSHOT DRIFT (intentional)" sentries in packages/db/src/schema/index.ts
// and docs/agents/database.md. Running generate emits a spurious diff
// migration that must not land, and nothing it emits is ever applied:
// production applies ONE step, the generated current-schema DDL.
process.stderr.write(
  [
    'BLOCKED: drizzle-kit generate is disabled in this repo.',
    '',
    'The drizzle snapshot is deliberately drifted — see the "SNAPSHOT DRIFT',
    '(intentional)" sentries in packages/db/src/schema/index.ts and',
    'docs/agents/database.md. Production applies ONE step, the generated',
    'current-schema DDL; regenerate it with `pnpm db:schema:ddl` instead.',
    '',
    'If you are absolutely sure (e.g. inspecting the drift itself), use:',
    '  pnpm db:generate:unsafe',
    '',
  ].join('\n')
);
process.exit(1);
