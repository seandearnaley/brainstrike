// BST-1705. The catalog's OpenRouter prices had drifted on 21 of its 58 rows,
// and THREE of those were not "stale" at all — they were read from a real
// payload, at the wrong number in it:
//
//   * `tencent/hy3` was recorded at 0.132 / 0.528, the rate its
//     `pricing.overrides` charge between 00:00 and 16:00 UTC. Its base is
//     0.0825 / 0.33. The author read `pricing.prompt` inside a peak window.
//   * `google/gemini-3.7-flash` and `z-ai/glm-5.3-flash` were recorded at
//     their `:batch` twin's rate — a different route entirely.
//
// (`provider-registry-pricing.test.ts` pins FOUR rows: those three plus
// `google/gemini-3.6-flash`, whose held 1.5 / 7.5 was exactly 2x the live base
// and matched no band, tier or variant route — a wrong number whose source was
// never identified, so it is pinned rather than classified.)
//
// The data these rows describe lives upstream and changes weekly, so it cannot
// be pinned here. The METHOD for reading it can be, and that is what failed.
// Every fixture below is a real payload shape from
// https://openrouter.ai/api/v1/models (retrieved 2026-09-10), including the
// same surge payload observed at BOTH a peak and an off-peak moment: the
// derivation must return the same base rate for both, or an author's luck with
// the clock decides what we ship.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  auditOpenRouterLimits,
  auditOpenRouterPricing,
  classifyHeldRate,
  deriveOpenRouterBaseRate,
  readFlagValue,
  readModelsEnvelope,
  splitOverrides,
  summarizeFindings,
  summarizeLimitFindings,
} from '../openrouter-pricing-audit.mjs';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

// Per-token decimals x 1e6 do not land on exact binary floats (0.0000000825 x
// 1e6 is 0.08250000000000001), so derived rates are compared with the same
// representation epsilon the audit itself uses. This is NOT a drift tolerance:
// 1e-9 relative cannot hide a price change.
function assertRate(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} is not ${expected}`
  );
}

/** anthropic/claude-sonnet-5 — no overrides at all. */
const FLAT_PRICING = { completion: '0.00001', prompt: '0.000002' };

/**
 * tencent/hy3 surge bands, verbatim. Two bands cover the whole day: the
 * 00:00-16:00 UTC peak at 1.6x, and 16:00-00:00 at the base.
 */
const HY3_BANDS = [
  {
    completion: '0.000000528',
    input_cache_read: '0.000000033',
    prompt: '0.000000132',
    utc_end: 1600,
    utc_start: 0,
  },
  {
    completion: '0.00000033',
    input_cache_read: '0.000000020625',
    prompt: '0.0000000825',
    utc_end: 0,
    utc_start: 1600,
  },
];
/** The same route read OUTSIDE the peak window: top level is the base rate. */
const HY3_OFF_PEAK = {
  completion: '0.00000033',
  overrides: HY3_BANDS,
  prompt: '0.0000000825',
};
/** The same route read INSIDE the peak window: top level is the surge rate. */
const HY3_AT_PEAK = {
  completion: '0.000000528',
  overrides: HY3_BANDS,
  prompt: '0.000000132',
};

/** deepseek/deepseek-v4.1-flash — weekend band plus five weekday windows. */
const DEEPSEEK_FLASH_PRICING = {
  completion: '0.0000006',
  overrides: [
    { completion: '0.0000006', prompt: '0.00000015', utc_days: ['saturday', 'sunday'] },
    {
      completion: '0.0000006',
      prompt: '0.00000015',
      utc_days: WEEKDAYS,
      utc_end: 100,
      utc_start: 0,
    },
    {
      completion: '0.0000012',
      prompt: '0.0000003',
      utc_days: WEEKDAYS,
      utc_end: 400,
      utc_start: 100,
    },
    {
      completion: '0.0000006',
      prompt: '0.00000015',
      utc_days: WEEKDAYS,
      utc_end: 600,
      utc_start: 400,
    },
    {
      completion: '0.0000012',
      prompt: '0.0000003',
      utc_days: WEEKDAYS,
      utc_end: 1000,
      utc_start: 600,
    },
    {
      completion: '0.0000006',
      prompt: '0.00000015',
      utc_days: WEEKDAYS,
      utc_end: 0,
      utc_start: 1000,
    },
  ],
  prompt: '0.00000015',
};

/** openai/gpt-5.5 — a long-context TIER, not a clock band. */
const GPT_55_PRICING = {
  completion: '0.00003',
  input_cache_read: '0.0000005',
  overrides: [
    {
      completion: '0.000045',
      input_cache_read: '0.000001',
      min_prompt_tokens: 272_000,
      prompt: '0.00001',
    },
  ],
  prompt: '0.000005',
};

test('a route without overrides prices at its top-level rate', () => {
  const base = deriveOpenRouterBaseRate(FLAT_PRICING);
  assert.equal(base.basis, 'flat');
  assert.equal(base.surgeMultiplier, 1);
  assertRate(base.inputPerMTok, 2, 'input');
  assertRate(base.outputPerMTok, 10, 'output');
});

test('a surge route prices at its base rate when read OFF peak', () => {
  const base = deriveOpenRouterBaseRate(HY3_OFF_PEAK);
  assert.equal(base.basis, 'off-peak-band');
  assertRate(base.inputPerMTok, 0.0825, 'input');
  assertRate(base.outputPerMTok, 0.33, 'output');
});

test('a surge route prices at its base rate when read AT peak — the BST-1705 bug', () => {
  // Read naively, this payload says 0.132 / 0.528. That is what shipped.
  assert.ok(Math.abs(Number(HY3_AT_PEAK.prompt) * 1_000_000 - 0.132) < 1e-9);
  const base = deriveOpenRouterBaseRate(HY3_AT_PEAK);
  assertRate(base.inputPerMTok, 0.0825, 'input');
  assertRate(base.outputPerMTok, 0.33, 'output');
  assertRate(base.surgeMultiplier, 1.6, 'surge multiplier');
});

test('the derivation is independent of the moment the payload was fetched', () => {
  const atPeak = deriveOpenRouterBaseRate(HY3_AT_PEAK);
  const offPeak = deriveOpenRouterBaseRate(HY3_OFF_PEAK);
  assert.deepEqual(atPeak, offPeak);
});

test('weekday/weekend band sets resolve to the off-peak rate', () => {
  const base = deriveOpenRouterBaseRate(DEEPSEEK_FLASH_PRICING);
  assert.equal(base.basis, 'off-peak-band');
  assertRate(base.inputPerMTok, 0.15, 'input');
  assertRate(base.outputPerMTok, 0.6, 'output');
  assertRate(base.surgeMultiplier, 2, 'surge multiplier');
});

test('a long-context tier never displaces the base rate', () => {
  const base = deriveOpenRouterBaseRate(GPT_55_PRICING);
  assert.equal(base.basis, 'flat');
  assertRate(base.inputPerMTok, 5, 'input');
  assertRate(base.outputPerMTok, 30, 'output');
  const { contextTiers, timeBands } = splitOverrides(GPT_55_PRICING);
  assert.equal(contextTiers.length, 1);
  assert.equal(timeBands.length, 0);
});

test('bands that leave part of the week uncovered fail closed', () => {
  // Only the peak window is declared, so the base rate is invisible to anyone
  // reading during it. Guessing the top-level rate here is the original bug.
  assert.throws(
    () =>
      deriveOpenRouterBaseRate({
        completion: '0.000000528',
        overrides: [HY3_BANDS[0]],
        prompt: '0.000000132',
      }),
    /base rate is not derivable/
  );
});

test('a top-level rate matching no band fails closed', () => {
  assert.throws(
    () =>
      deriveOpenRouterBaseRate({
        completion: '0.000001',
        overrides: HY3_BANDS,
        prompt: '0.0000005',
      }),
    /matches no surge band/
  );
});

test('malformed rates fail closed rather than defaulting', () => {
  assert.throws(() => deriveOpenRouterBaseRate({ prompt: '0.000002' }), /completion is missing/);
  assert.throws(
    () => deriveOpenRouterBaseRate({ completion: 'n/a', prompt: '0.000002' }),
    /not a non-negative number/
  );
  assert.throws(() => deriveOpenRouterBaseRate(null), /pricing is not an object/);
  assert.throws(
    () => deriveOpenRouterBaseRate({ completion: '1', overrides: {}, prompt: '1' }),
    /overrides is not an array/
  );
});

test('an empty-string rate is rejected, not read as free', () => {
  // `Number('')` and `Number('  ')` are both 0, which passes a
  // `Number.isFinite() && >= 0` guard and records a paid route as free.
  assert.throws(
    () => deriveOpenRouterBaseRate({ completion: '0.00001', prompt: '' }),
    /pricing\.prompt is an empty string/
  );
  assert.throws(
    () => deriveOpenRouterBaseRate({ completion: '   ', prompt: '0.000002' }),
    /pricing\.completion is an empty string/
  );
});

test('an override with no recognised discriminator fails closed', () => {
  // The fail-open this replaces: an entry that is not a `min_prompt_tokens`
  // tier used to be assumed to be a clock band, and `bandMinutes` defaults
  // every absent UTC field — so this entry became a band covering the WHOLE
  // WEEK and won the cheapest-band reduce. The payload below returned
  // 0.01 / 0.1 as `tencent/hy3`'s base rate instead of 0.0825 / 0.33.
  const promoShape = {
    completion: '0.00000033',
    overrides: [
      ...HY3_BANDS,
      { completion: '0.0000001', promo_code: 'LAUNCH50', prompt: '0.00000001' },
    ],
    prompt: '0.0000000825',
  };
  assert.throws(() => splitOverrides(promoShape), /declares no recognised discriminator/);
  assert.throws(() => deriveOpenRouterBaseRate(promoShape), /promo_code/);
});

test('an override mixing a long-context tier with a clock band fails closed', () => {
  assert.throws(
    () =>
      deriveOpenRouterBaseRate({
        completion: '0.00000033',
        overrides: [
          {
            completion: '0.000000528',
            min_prompt_tokens: 272_000,
            prompt: '0.000000132',
            utc_end: 1600,
            utc_start: 0,
          },
        ],
        prompt: '0.0000000825',
      }),
    /mixes min_prompt_tokens with a time-band key/
  );
});

/** The same two hy3 windows, surging on OUTPUT only. */
const OUTPUT_ONLY_SURGE = {
  completion: '0.00000033',
  overrides: [
    { completion: '0.000000528', prompt: '0.0000000825', utc_end: 1600, utc_start: 0 },
    { completion: '0.00000033', prompt: '0.0000000825', utc_end: 0, utc_start: 1600 },
  ],
  prompt: '0.0000000825',
};

test('a surge on output alone is neither reported as flat nor decided by band order', () => {
  const base = deriveOpenRouterBaseRate(OUTPUT_ONLY_SURGE);
  assertRate(base.inputPerMTok, 0.0825, 'input');
  assertRate(base.outputPerMTok, 0.33, 'output');
  // Input ties across both bands, so an input-only multiplier reports 1 and an
  // input-only comparison picks whichever band the payload happens to list
  // first. Neither may decide the answer.
  assertRate(base.surgeMultiplier, 1.6, 'surge multiplier');
  assert.deepEqual(
    deriveOpenRouterBaseRate({
      ...OUTPUT_ONLY_SURGE,
      overrides: [...OUTPUT_ONLY_SURGE.overrides].reverse(),
    }),
    base
  );
});

test('a free band beside a paid one reports an infinite multiplier, never 1', () => {
  const base = deriveOpenRouterBaseRate({
    completion: '0',
    overrides: [
      { completion: '0.000000528', prompt: '0.000000132', utc_end: 1600, utc_start: 0 },
      { completion: '0', prompt: '0', utc_end: 0, utc_start: 1600 },
    ],
    prompt: '0',
  });
  assertRate(base.inputPerMTok, 0, 'input');
  assert.equal(base.surgeMultiplier, Number.POSITIVE_INFINITY);
});

test('a held rate is classified by which wrong number it equals', () => {
  const hy3 = { id: 'tencent/hy3', pricing: HY3_OFF_PEAK };
  assert.equal(
    classifyHeldRate({ held: { inputPerMTok: 0.132, outputPerMTok: 0.528 }, live: hy3 }),
    'surge-band'
  );
  assert.equal(
    classifyHeldRate({
      held: { inputPerMTok: 10, outputPerMTok: 45 },
      live: { id: 'openai/gpt-5.5', pricing: GPT_55_PRICING },
    }),
    'long-context-tier'
  );
  assert.equal(
    classifyHeldRate({
      held: { inputPerMTok: 0.375, outputPerMTok: 1.875 },
      live: {
        id: 'google/gemini-3.7-flash',
        pricing: { completion: '0.00000375', prompt: '0.00000075' },
      },
      variants: [
        {
          id: 'google/gemini-3.7-flash:batch',
          pricing: { completion: '0.000001875', prompt: '0.000000375' },
        },
      ],
    }),
    'variant-route:google/gemini-3.7-flash:batch'
  );
  assert.equal(
    classifyHeldRate({ held: { inputPerMTok: 99, outputPerMTok: 99 }, live: hy3 }),
    'moved-upstream'
  );
});

const LIVE_FIXTURE = [
  { id: 'tencent/hy3', pricing: HY3_OFF_PEAK },
  { id: 'anthropic/claude-sonnet-5', pricing: FLAT_PRICING },
  { id: 'openai/gpt-5.5', pricing: GPT_55_PRICING },
  {
    id: 'google/gemini-3.7-flash',
    pricing: { completion: '0.00000375', prompt: '0.00000075' },
  },
  {
    id: 'google/gemini-3.7-flash:batch',
    pricing: { completion: '0.000001875', prompt: '0.000000375' },
  },
];

function catalogWith(models) {
  return [
    {
      id: 'openai',
      models: [{ id: 'gpt-5.5', pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } }],
    },
    { id: 'openrouter', models },
  ];
}

test('a catalog holding every base rate reports no findings', () => {
  const result = auditOpenRouterPricing({
    catalog: catalogWith([
      { id: 'tencent/hy3', pricing: { inputPerMTok: 0.0825, outputPerMTok: 0.33 }, type: 'llm' },
      {
        id: 'anthropic/claude-sonnet-5',
        pricing: { inputPerMTok: 2, outputPerMTok: 10 },
        type: 'llm',
      },
      { id: 'openai/gpt-5.5', pricing: { inputPerMTok: 5, outputPerMTok: 30 }, type: 'llm' },
    ]),
    liveModels: LIVE_FIXTURE,
  });
  assert.equal(result.audited, 3);
  assert.deepEqual(result.findings, []);
});

test('a surge rate in the catalog is a finding named as a surge read', () => {
  const { findings } = auditOpenRouterPricing({
    catalog: catalogWith([
      // The exact row that shipped before BST-1705.
      { id: 'tencent/hy3', pricing: { inputPerMTok: 0.132, outputPerMTok: 0.528 }, type: 'llm' },
    ]),
    liveModels: LIVE_FIXTURE,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'price-drift');
  assert.equal(findings[0].modelId, 'tencent/hy3');
  assert.equal(findings[0].classification, 'surge-band');
  assertRate(findings[0].base.inputPerMTok, 0.0825, 'base input');
});

test('a :batch rate in the standard route row names the variant it came from', () => {
  const { findings } = auditOpenRouterPricing({
    catalog: catalogWith([
      {
        id: 'google/gemini-3.7-flash',
        pricing: { inputPerMTok: 0.375, outputPerMTok: 1.875 },
        type: 'llm',
      },
    ]),
    liveModels: LIVE_FIXTURE,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].classification, 'variant-route:google/gemini-3.7-flash:batch');
});

test('tolerance absorbs a fraction of the base rate and nothing more', () => {
  const catalog = catalogWith([
    { id: 'openai/gpt-5.5', pricing: { inputPerMTok: 5.02, outputPerMTok: 30 }, type: 'llm' },
  ]);
  assert.equal(
    auditOpenRouterPricing({ catalog, liveModels: LIVE_FIXTURE, tolerance: 0.01 }).findings.length,
    0
  );
  assert.equal(
    auditOpenRouterPricing({ catalog, liveModels: LIVE_FIXTURE, tolerance: 0.001 }).findings.length,
    1
  );
  assert.equal(auditOpenRouterPricing({ catalog, liveModels: LIVE_FIXTURE }).findings.length, 1);
});

test('rows the gateway no longer publishes, and unpriced rows, are findings too', () => {
  const { audited, findings } = auditOpenRouterPricing({
    catalog: catalogWith([
      { id: 'vendor/retired-route', pricing: { inputPerMTok: 1, outputPerMTok: 2 }, type: 'llm' },
      { id: 'vendor/no-price', type: 'llm' },
      { id: 'vendor/embeddings', type: 'embedding' },
    ]),
    liveModels: LIVE_FIXTURE,
  });
  assert.equal(audited, 0);
  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.modelId]),
    [
      ['route-missing', 'vendor/retired-route'],
      ['unpriced-row', 'vendor/no-price'],
    ]
  );
});

test('the audit refuses a catalog with no openrouter provider', () => {
  assert.throws(
    () => auditOpenRouterPricing({ catalog: [{ id: 'openai', models: [] }], liveModels: [] }),
    /no "openrouter" provider/
  );
});

test('one unreadable live payload is a finding, not the end of the run', () => {
  // A shape change on ONE upstream route used to throw straight out of the
  // loop, so the author got a stack trace instead of a 58-row catalog diff.
  // The row still never passes, and the CLI still exits 1.
  const { audited, findings } = auditOpenRouterPricing({
    catalog: catalogWith([
      { id: 'vendor/unreadable', pricing: { inputPerMTok: 1, outputPerMTok: 2 }, type: 'llm' },
      { id: 'tencent/hy3', pricing: { inputPerMTok: 0.0825, outputPerMTok: 0.33 }, type: 'llm' },
      { id: 'openai/gpt-5.5', pricing: { inputPerMTok: 9, outputPerMTok: 9 }, type: 'llm' },
    ]),
    liveModels: [
      ...LIVE_FIXTURE,
      {
        id: 'vendor/unreadable',
        // Only the peak window is declared, so no base rate is derivable.
        pricing: { completion: '0.000000528', overrides: [HY3_BANDS[0]], prompt: '0.000000132' },
      },
    ],
  });
  assert.equal(audited, 2);
  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.modelId]),
    [
      ['shape-unrecognised', 'vendor/unreadable'],
      ['price-drift', 'openai/gpt-5.5'],
    ]
  );
  assert.match(findings[0].reason, /base rate is not derivable/);
});

test('a catalog row whose pricing carries no numbers is unpriced, not drifted', () => {
  // `held undefined / outputPerMTok undefined` compares NaN against the live
  // rate, fails every check, and used to render as a price MOVEMENT.
  const { audited, findings } = auditOpenRouterPricing({
    catalog: catalogWith([
      { id: 'openai/gpt-5.5', pricing: {}, type: 'llm' },
      { id: 'tencent/hy3', pricing: { inputPerMTok: '0.0825', outputPerMTok: 0.33 }, type: 'llm' },
    ]),
    liveModels: LIVE_FIXTURE,
  });
  assert.equal(audited, 0);
  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.modelId]),
    [
      ['unpriced-row', 'openai/gpt-5.5'],
      ['unpriced-row', 'tencent/hy3'],
    ]
  );
});

test('the failure summary counts drift apart from rows that could not be audited', () => {
  // The exact shape of the `rows the gateway no longer publishes` case above,
  // which the old line reported as "2 of 0 routes disagree".
  assert.equal(
    summarizeFindings({
      audited: 0,
      findings: [{ kind: 'route-missing' }, { kind: 'unpriced-row' }],
    }),
    'openrouter pricing audit: 0 of 0 audited routes disagree with the live base rate; 2 row(s) could not be audited.'
  );
  assert.equal(
    summarizeFindings({ audited: 12, findings: [{ kind: 'price-drift' }] }),
    'openrouter pricing audit: 1 of 12 audited routes disagree with the live base rate.'
  );
});

test('a flag value keeps its own `=` and is never silently empty', () => {
  assert.equal(
    readFlagValue(['--fixture=/tmp/a=b/models.json'], '--fixture'),
    '/tmp/a=b/models.json'
  );
  assert.equal(readFlagValue(['--tolerance=0.01'], '--tolerance'), '0.01');
  assert.equal(readFlagValue([], '--fixture'), undefined);
  // `Number('')` is 0, so an empty --tolerance used to pass the non-negative
  // guard as an exact-match run rather than being rejected.
  assert.throws(
    () => readFlagValue(['--tolerance='], '--tolerance'),
    /--tolerance requires a value/
  );
});

test('a response that is not the Models API envelope fails by name', () => {
  assert.deepEqual(readModelsEnvelope({ data: [] }, 'source'), []);
  for (const payload of [{}, null, { data: {} }, []]) {
    assert.throws(
      () => readModelsEnvelope(payload, 'source'),
      /source did not return the expected/
    );
  }
});

// BST-1804. An OpenRouter row's contextWindow and maxOutputTokens are the
// route's `top_provider` pair (docs/agents/assistant-providers.md), because
// contextWindow sets the compaction limit and a larger model-level window may
// be served by one provider only. 28 of 73 rows had drifted from it while the
// rule was documented but unenforced. Fixtures are the live
// https://openrouter.ai/api/v1/models shapes read 2026-09-23 UTC, trimmed to
// the fields the check reads.
const LIMITS_FIXTURE = [
  {
    // Model-level window served by one provider; the top provider serves less.
    context_length: 1_310_720,
    id: 'z-ai/glm-5.3-flash',
    top_provider: {
      context_length: 1_048_576,
      is_moderated: false,
      max_completion_tokens: 943_718,
    },
  },
  {
    // Router meta-model: the only shape that publishes a null top-provider window.
    context_length: 200_000,
    id: 'openrouter/free',
    top_provider: { context_length: null, is_moderated: false, max_completion_tokens: null },
  },
];

function limitsCatalogWith(models) {
  return catalogWith(models.map((model) => ({ type: 'llm', ...model })));
}

test('a row holding the top-provider pair reports no limit findings', () => {
  const { audited, findings } = auditOpenRouterLimits({
    catalog: limitsCatalogWith([
      { contextWindow: 1_048_576, id: 'z-ai/glm-5.3-flash', maxOutputTokens: 943_718 },
    ]),
    liveModels: LIMITS_FIXTURE,
  });
  assert.equal(audited, 1);
  assert.deepEqual(findings, []);
});

test('the larger model-level window is limit drift, not the route limit', () => {
  // The exact row that shipped before this check existed.
  const { findings } = auditOpenRouterLimits({
    catalog: limitsCatalogWith([
      { contextWindow: 1_310_720, id: 'z-ai/glm-5.3-flash', maxOutputTokens: 131_072 },
    ]),
    liveModels: LIMITS_FIXTURE,
  });
  assert.deepEqual(findings, [
    {
      expected: { contextWindow: 1_048_576, maxOutputTokens: 943_718 },
      held: { contextWindow: 1_310_720, maxOutputTokens: 131_072 },
      kind: 'limit-drift',
      modelId: 'z-ai/glm-5.3-flash',
    },
  ]);
});

test('each half of the pair drifts on its own', () => {
  const windowOnly = auditOpenRouterLimits({
    catalog: limitsCatalogWith([
      { contextWindow: 1_000_000, id: 'z-ai/glm-5.3-flash', maxOutputTokens: 943_718 },
    ]),
    liveModels: LIMITS_FIXTURE,
  });
  assert.deepEqual(
    windowOnly.findings.map((finding) => finding.kind),
    ['limit-drift']
  );
  // An omitted max output is drift when the route publishes one.
  const outputOmitted = auditOpenRouterLimits({
    catalog: limitsCatalogWith([{ contextWindow: 1_048_576, id: 'z-ai/glm-5.3-flash' }]),
    liveModels: LIMITS_FIXTURE,
  });
  assert.deepEqual(outputOmitted.findings[0].held, {
    contextWindow: 1_048_576,
    maxOutputTokens: undefined,
  });
});

test('only a NULL top-provider window reads the model-level window, and a null output limit is omitted', () => {
  const holds = auditOpenRouterLimits({
    catalog: limitsCatalogWith([{ contextWindow: 200_000, id: 'openrouter/free' }]),
    liveModels: LIMITS_FIXTURE,
  });
  assert.deepEqual(holds.findings, []);
  const invented = auditOpenRouterLimits({
    catalog: limitsCatalogWith([
      { contextWindow: 200_000, id: 'openrouter/free', maxOutputTokens: 32_000 },
    ]),
    liveModels: LIMITS_FIXTURE,
  });
  assert.deepEqual(invented.findings[0].expected, {
    contextWindow: 200_000,
    maxOutputTokens: undefined,
  });
});

test('an absent or malformed top-provider limit is unreadable, never a fallback', () => {
  const liveModels = [
    {
      context_length: 200_000,
      id: 'vendor/absent-window',
      top_provider: { max_completion_tokens: 8192 },
    },
    {
      context_length: 200_000,
      id: 'vendor/absent-output',
      top_provider: { context_length: 200_000 },
    },
    {
      context_length: 200_000,
      id: 'vendor/zero-window',
      top_provider: { context_length: 0, max_completion_tokens: null },
    },
    { context_length: 200_000, id: 'vendor/no-top-provider' },
  ];
  const { audited, findings } = auditOpenRouterLimits({
    catalog: limitsCatalogWith(
      liveModels.map((model) => ({ contextWindow: 200_000, id: model.id }))
    ),
    liveModels,
  });
  assert.equal(audited, 0);
  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.modelId]),
    [
      ['limit-shape-unrecognised', 'vendor/absent-window'],
      ['limit-shape-unrecognised', 'vendor/absent-output'],
      ['limit-shape-unrecognised', 'vendor/zero-window'],
      ['limit-shape-unrecognised', 'vendor/no-top-provider'],
    ]
  );
  assert.match(findings[0].reason, /top_provider\.context_length/);
  assert.match(findings[1].reason, /top_provider\.max_completion_tokens/);
});

test('a row the gateway no longer publishes is a limit finding too, and non-LLM rows are skipped', () => {
  const { audited, findings } = auditOpenRouterLimits({
    catalog: limitsCatalogWith([
      { contextWindow: 8192, id: 'vendor/retired-route' },
      { id: 'vendor/embeddings', type: 'embedding' },
    ]),
    liveModels: LIMITS_FIXTURE,
  });
  assert.equal(audited, 0);
  assert.deepEqual(findings, [{ kind: 'route-missing', modelId: 'vendor/retired-route' }]);
});

test('the limits summary counts drift apart from rows that could not be audited', () => {
  assert.equal(
    summarizeLimitFindings({
      audited: 3,
      findings: [{ kind: 'limit-drift' }, { kind: 'route-missing' }],
    }),
    'openrouter limits audit: 1 of 3 audited routes disagree with the top-provider pair; 1 row(s) could not be audited.'
  );
});
