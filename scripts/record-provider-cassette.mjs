#!/usr/bin/env node
// pnpm cassettes:record <scenario id|all>
//
// Records provider cassettes through the host-level lane: each scenario runs on
// the real standalone host against its real provider, holding the key you have
// exported in this shell (OPENROUTER_API_KEY, ANTHROPIC_API_KEY or
// OPENAI_API_KEY). A cassette is written only once it is clean, shows its
// scenario's behavior, keeps every invariant and replays to the same shape.
// Review the shape snapshot diff afterwards. See docs/agents/provider-cassettes.md.
import { spawnSync } from 'node:child_process';

const [scenario, ...extra] = process.argv.slice(2);
if (!scenario || extra.length > 0) {
  console.error('Usage: pnpm cassettes:record <scenario id|all>');
  process.exit(2);
}
const result = spawnSync(
  'pnpm',
  [
    '--filter',
    '@brainstrike/desktop',
    'test:provider-cassettes',
    '-u',
    ...(scenario === 'all' ? [] : ['-t', `provider cassette ${scenario} `]),
  ],
  { env: { ...process.env, BRAINSTRIKE_PROVIDER_CASSETTE_RECORD: scenario }, stdio: 'inherit' }
);
process.exit(result.status ?? 1);
