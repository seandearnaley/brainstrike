// BST-1708 tier audit. Companion to openrouter-pricing-audit.test.mjs: that
// file owns the base-rate derivation, the limits check, and the shared shape
// fixtures. This file owns `deriveOpenRouterContextTiers` and
// `auditOpenRouterTiers`. Split because the ultracite 1000-line file cap
// forbids keeping both suites in one file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  auditOpenRouterTiers,
  deriveOpenRouterContextTiers,
  summarizeTierFindings,
} from '../openrouter-pricing-audit.mjs';

// Per-token decimals x 1e6 do not land on exact binary floats, so derived
// rates are compared with the same representation epsilon the audit itself
// uses. Mirrors assertRate in openrouter-pricing-audit.test.mjs.
function assertRate(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} is not ${expected}`
  );
}

/** anthropic/claude-sonnet-5 — no overrides at all. Mirrors FLAT_PRICING. */
const FLAT_PRICING = { completion: '0.00001', prompt: '0.000002' };

function catalogWith(models) {
  return [
    {
      id: 'openai',
      models: [{ id: 'gpt-5.5', pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } }],
    },
    { id: 'openrouter', models },
  ];
}

// BST-1708. Rows carrying `pricing.longContextTiers` drive `computeCost` tier
// selection, so a stale threshold or tier/cache rate must fail this audit the
// way a stale base rate fails the pricing one. Fixtures are the live
// https://openrouter.ai/api/v1/models shapes read 2026-09-28 UTC, trimmed to
// the fields the check reads.
/** openai/gpt-6-astra — one tier carrying every rate the catalog models. */
const ASTRA_PRICING = {
  completion: '0.00005',
  input_cache_read: '0.000001',
  input_cache_write: '0.0000125',
  overrides: [
    {
      completion: '0.000075',
      input_cache_read: '0.000002',
      input_cache_write: '0.000025',
      min_prompt_tokens: 272_000,
      prompt: '0.00002',
    },
  ],
  prompt: '0.00001',
};
/** qwen/qwen3.7-flash — two tiers, written upstream in ascending order. */
const QWEN_FLASH_PRICING = {
  completion: '0.00000013',
  input_cache_read: '0.000000006',
  input_cache_write: '0.000000038',
  overrides: [
    {
      completion: '0.0000004',
      input_cache_read: '0.00000002',
      input_cache_write: '0.000000125',
      min_prompt_tokens: 32_000,
      prompt: '0.0000001',
    },
    {
      completion: '0.0000008',
      input_cache_read: '0.00000004',
      input_cache_write: '0.00000025',
      min_prompt_tokens: 256_000,
      prompt: '0.0000002',
    },
  ],
  prompt: '0.00000003',
};
/** x-ai/grok-4.7 — a tier publishing no cache-write rate. */
const GROK_47_PRICING = {
  completion: '0.0000048',
  input_cache_read: '0.0000004',
  overrides: [
    {
      completion: '0.0000096',
      input_cache_read: '0.0000008',
      min_prompt_tokens: 200_000,
      prompt: '0.0000032',
    },
  ],
  prompt: '0.0000016',
  web_search: '0.005',
};
/** google/gemini-3.1-pro-preview — a tier carrying audio rates the catalog does not model. */
const GEMINI_31_PRICING = {
  audio: '0.000002',
  completion: '0.000012',
  image: '0.000002',
  input_audio_cache: '0.0000002',
  input_cache_read: '0.0000002',
  input_cache_write: '0.000000375',
  internal_reasoning: '0.000012',
  overrides: [
    {
      audio: '0.000004',
      completion: '0.000018',
      input_audio_cache: '0.0000004',
      input_cache_read: '0.0000004',
      min_prompt_tokens: 200_000,
      prompt: '0.000004',
    },
  ],
  prompt: '0.000002',
  web_search: '0.014',
};

const TIER_FIXTURE = [
  { id: 'openai/gpt-6-astra', pricing: ASTRA_PRICING },
  { id: 'qwen/qwen3.7-flash', pricing: QWEN_FLASH_PRICING },
  { id: 'x-ai/grok-4.7', pricing: GROK_47_PRICING },
  { id: 'google/gemini-3.1-pro-preview', pricing: GEMINI_31_PRICING },
  { id: 'anthropic/claude-sonnet-5', pricing: FLAT_PRICING },
];

function tiersCatalogWith(models) {
  return catalogWith(models.map((model) => ({ type: 'llm', ...model })));
}

test('a tier carrying every modelled rate derives to per-MTok with its threshold', () => {
  assert.deepEqual(deriveOpenRouterContextTiers(ASTRA_PRICING), [
    {
      cacheReadPerMTok: 2,
      cacheWritePerMTok: 25,
      inputPerMTok: 20,
      minPromptTokens: 272_000,
      outputPerMTok: 75,
    },
  ]);
});

test('tiers derive sorted by threshold, not by upstream array order', () => {
  const reversed = {
    ...QWEN_FLASH_PRICING,
    overrides: [...QWEN_FLASH_PRICING.overrides].reverse(),
  };
  const tiers = deriveOpenRouterContextTiers(reversed);
  assert.deepEqual(
    tiers.map((tier) => tier.minPromptTokens),
    [32_000, 256_000]
  );
  assertRate(tiers[0].inputPerMTok, 0.1, 'first tier input');
  assertRate(tiers[1].inputPerMTok, 0.2, 'second tier input');
});

test('a tier without cache rates derives them as absent, and audio rates are ignored', () => {
  // grok publishes no tier cache-write; gemini publishes audio rates the
  // catalog schema does not model. Both are real upstream shapes: the
  // derivation reads the five modelled fields and nothing else, the way the
  // base-rate derivation ignores top-level web_search. Absent cache rates are
  // absent keys, because deepStrictEqual distinguishes those from undefined.
  const [grok] = deriveOpenRouterContextTiers(GROK_47_PRICING);
  assert.equal(grok.minPromptTokens, 200_000);
  assertRate(grok.inputPerMTok, 3.2, 'grok tier input');
  assertRate(grok.outputPerMTok, 9.6, 'grok tier output');
  assertRate(grok.cacheReadPerMTok, 0.8, 'grok tier cache-read');
  assert.deepEqual(Object.keys(grok).sort(), [
    'cacheReadPerMTok',
    'inputPerMTok',
    'minPromptTokens',
    'outputPerMTok',
  ]);
  const [gemini] = deriveOpenRouterContextTiers(GEMINI_31_PRICING);
  assert.equal(gemini.minPromptTokens, 200_000);
  assertRate(gemini.inputPerMTok, 4, 'gemini tier input');
  assertRate(gemini.cacheReadPerMTok, 0.4, 'gemini tier cache-read');
  assert.deepEqual(Object.keys(gemini).sort(), [
    'cacheReadPerMTok',
    'inputPerMTok',
    'minPromptTokens',
    'outputPerMTok',
  ]);
});

test('an unusable threshold or a duplicated one fails closed', () => {
  for (const minPromptTokens of [0, -1000, 272_000.5, '272000', Number.NaN]) {
    assert.throws(
      () =>
        deriveOpenRouterContextTiers({
          ...ASTRA_PRICING,
          overrides: [{ ...ASTRA_PRICING.overrides[0], min_prompt_tokens: minPromptTokens }],
        }),
      /min_prompt_tokens/,
      `threshold ${String(minPromptTokens)}`
    );
  }
  // Two entries at one threshold leave computeCost tier selection ambiguous:
  // "the highest tier at or below" is no longer one tier.
  assert.throws(
    () =>
      deriveOpenRouterContextTiers({
        ...ASTRA_PRICING,
        overrides: [ASTRA_PRICING.overrides[0], ASTRA_PRICING.overrides[0]],
      }),
    /duplicate min_prompt_tokens/
  );
});

test('a tier with an unreadable rate fails closed', () => {
  assert.throws(
    () =>
      deriveOpenRouterContextTiers({
        ...ASTRA_PRICING,
        overrides: [{ ...ASTRA_PRICING.overrides[0], prompt: '0.00002 each' }],
      }),
    /not a non-negative number/
  );
});

test('rows holding the live tiers report no tier findings', () => {
  const { audited, findings } = auditOpenRouterTiers({
    catalog: tiersCatalogWith([
      {
        id: 'openai/gpt-6-astra',
        pricing: {
          inputPerMTok: 10,
          longContextTiers: [
            {
              cacheReadPerMTok: 2,
              cacheWritePerMTok: 25,
              inputPerMTok: 20,
              minPromptTokens: 272_000,
              outputPerMTok: 75,
            },
          ],
          outputPerMTok: 50,
        },
      },
      {
        id: 'x-ai/grok-4.7',
        pricing: {
          inputPerMTok: 1.6,
          longContextTiers: [
            {
              cacheReadPerMTok: 0.8,
              inputPerMTok: 3.2,
              minPromptTokens: 200_000,
              outputPerMTok: 9.6,
            },
          ],
          outputPerMTok: 4.8,
        },
      },
    ]),
    liveModels: TIER_FIXTURE,
  });
  assert.equal(audited, 2);
  assert.deepEqual(findings, []);
});

test('a stale tier threshold, rate or cache rate is tier drift', () => {
  const { findings } = auditOpenRouterTiers({
    catalog: tiersCatalogWith([
      {
        id: 'openai/gpt-6-astra',
        pricing: {
          inputPerMTok: 10,
          longContextTiers: [
            {
              cacheReadPerMTok: 2,
              cacheWritePerMTok: 25,
              inputPerMTok: 20,
              minPromptTokens: 200_000,
              outputPerMTok: 75,
            },
          ],
          outputPerMTok: 50,
        },
      },
      {
        id: 'x-ai/grok-4.7',
        pricing: {
          inputPerMTok: 1.6,
          longContextTiers: [
            {
              cacheReadPerMTok: 0.9,
              inputPerMTok: 3.2,
              minPromptTokens: 200_000,
              outputPerMTok: 9.6,
            },
          ],
          outputPerMTok: 4.8,
        },
      },
    ]),
    liveModels: TIER_FIXTURE,
  });
  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.modelId]),
    [
      ['tier-drift', 'openai/gpt-6-astra'],
      ['tier-drift', 'x-ai/grok-4.7'],
    ]
  );
  assert.equal(findings[0].expected[0].minPromptTokens, 272_000);
  assertRate(findings[1].expected[0].cacheReadPerMTok, 0.8, 'live cache-read');
});

test('tiers the gateway no longer publishes are drift, and rows without held tiers are skipped', () => {
  const { audited, findings } = auditOpenRouterTiers({
    catalog: tiersCatalogWith([
      {
        id: 'openai/gpt-6-astra',
        pricing: {
          inputPerMTok: 10,
          longContextTiers: [
            {
              cacheReadPerMTok: 2,
              cacheWritePerMTok: 25,
              inputPerMTok: 20,
              minPromptTokens: 272_000,
              outputPerMTok: 75,
            },
          ],
          outputPerMTok: 50,
        },
      },
      // Live tiers this row does not model: tier coverage is an authoring
      // decision, so unmodelled tiers are not findings. Flat rows cannot drift.
      { id: 'anthropic/claude-sonnet-5', pricing: { inputPerMTok: 2, outputPerMTok: 10 } },
      { id: 'qwen/qwen3.7-flash', pricing: { inputPerMTok: 0.03, outputPerMTok: 0.13 } },
      { id: 'vendor/embeddings', type: 'embedding' },
    ]),
    liveModels: TIER_FIXTURE.map((model) =>
      model.id === 'openai/gpt-6-astra'
        ? { ...model, pricing: { ...model.pricing, overrides: [] } }
        : model
    ),
  });
  assert.equal(audited, 1);
  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.modelId]),
    [['tier-drift', 'openai/gpt-6-astra']]
  );
  assert.deepEqual(findings[0].expected, []);
});

test('an unreadable live tier payload is a finding, and a retired route too', () => {
  const { audited, findings } = auditOpenRouterTiers({
    catalog: tiersCatalogWith([
      {
        id: 'vendor/unreadable',
        pricing: {
          inputPerMTok: 1,
          longContextTiers: [{ inputPerMTok: 2, minPromptTokens: 100_000, outputPerMTok: 4 }],
          outputPerMTok: 2,
        },
      },
      {
        id: 'vendor/retired-route',
        pricing: {
          inputPerMTok: 1,
          longContextTiers: [{ inputPerMTok: 2, minPromptTokens: 100_000, outputPerMTok: 4 }],
          outputPerMTok: 2,
        },
      },
    ]),
    liveModels: [
      ...TIER_FIXTURE,
      {
        id: 'vendor/unreadable',
        pricing: {
          completion: '0.000002',
          overrides: [{ min_prompt_tokens: 100_000, prompt: 'free with purchase' }],
        },
      },
    ],
  });
  assert.equal(audited, 0);
  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.modelId]),
    [
      ['tier-shape-unrecognised', 'vendor/unreadable'],
      ['route-missing', 'vendor/retired-route'],
    ]
  );
});

test('the tier summary counts drift apart from rows that could not be audited', () => {
  assert.equal(
    summarizeTierFindings({
      audited: 2,
      findings: [{ kind: 'tier-drift' }, { kind: 'route-missing' }],
    }),
    'openrouter tier audit: 1 of 2 audited routes disagree with the live long-context tiers; 1 row(s) could not be audited.'
  );
  assert.equal(
    summarizeTierFindings({ audited: 14, findings: [] }),
    'openrouter tier audit: 14 routes match their live long-context tiers.'
  );
});

test('the tier audit refuses a catalog with no openrouter provider', () => {
  assert.throws(
    () => auditOpenRouterTiers({ catalog: [{ id: 'openai', models: [] }], liveModels: [] }),
    /no "openrouter" provider/
  );
});
