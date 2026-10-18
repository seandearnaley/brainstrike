/**
 * Bedrock cross-region inference-profile routing (BST-1350; per-model card
 * tables since BST-1738).
 *
 * The catalog stores UNPREFIXED Bedrock model ids (`anthropic.claude-sonnet-5`).
 * Most model/region pairs can only be invoked through an inference profile:
 * a GEO profile (`us.`, `eu.`, `au.`, `jp.`, `in.`, `apac.`, `ca.`) that keeps
 * data inside a geography, or the GLOBAL profile (`global.`) that routes
 * anywhere. The base id is In-Region ✗ in most regions, so sending it verbatim
 * there is a request Bedrock cannot answer.
 *
 * SOURCE OF TRUTH: each model's own AWS model card
 * (docs.aws.amazon.com/bedrock/latest/userguide/model-card-<slug>.html), all
 * retrieved 2026-10-18. Two sections per card feed BEDROCK_INFERENCE_ROUTES:
 * - "Geo inference details": one table per geo profile listing its SOURCE
 *   regions. A region gets that geo's prefix exactly when it is a source.
 * - "Regional availability" (bedrock-runtime): the regions marked Global ✓.
 *   Those that are not a geo source take `global.`.
 * Each card's Programmatic Access row was cross-checked against both: every
 * published Geo inference ID has a source table and vice versa, and a model
 * with a Global inference ID has Global ✓ regions. A third-party mirror
 * (models.dev) is never a source: it has listed profiles AWS never published
 * (`jp.anthropic.claude-sonnet-5`, BST-1710; `eu.anthropic.claude-fable-5`,
 * BST-1738) and missed ones AWS does publish.
 *
 * PRECEDENCE: geo first, global second, verbatim last. Data residency is the
 * stronger guarantee, so a region that is a source of the model's geo profile
 * gets it, even where the card also allows In-Region invocation (Nova in
 * us-east-1, Opus 5.5 in eu-west-2). `global.` covers the regions with no geo
 * profile. Anything else, including an uncatalogued id, is sent verbatim and
 * Bedrock reports the outcome: guessing a profile would fail worse.
 *
 * GOVCLOUD (`us-gov-*`) is deliberately left verbatim. Every card that lists it
 * marks it Global ✗, and its geo routing differs per model (Opus 4.8 publishes
 * a separate `us-gov.` profile, Sonnet 4.5 lists GovCloud as a source of `us.`,
 * the rest list no source table at all). It is excluded until someone verifies
 * it against a GovCloud account.
 *
 * An id already carrying a cross-region prefix passes through untouched (never
 * double-prefixed). There is NO default region here: the bedrock factory case
 * guarantees a validated region, because a missing one is a typed init failure.
 *
 * REFRESH: re-download every card the table names, re-read both sections, and
 * update the rows and the retrieval date above. The spec pins the regressions
 * this table fixed and the invariants every row must hold.
 */

const CROSS_REGION_PREFIXES = [
  'apac.',
  'au.',
  'ca.',
  'eu.',
  'global.',
  'in.',
  'jp.',
  'us-gov.',
  'us.',
] as const;

/** The geo profile prefixes the cards publish (GovCloud's `us-gov.` is excluded above). */
export type BedrockGeoPrefix = 'apac' | 'au' | 'ca' | 'eu' | 'in' | 'jp' | 'us';

export interface BedrockInferenceRoutes {
  /** Region → the geo profile it is a source region of. */
  readonly geo: ReadonlyMap<string, BedrockGeoPrefix>;
  /** Regions with no geo profile for the model that the card marks Global ✓. */
  readonly global: ReadonlySet<string>;
}

function routes(
  geo: Partial<Record<BedrockGeoPrefix, readonly string[]>>,
  global: readonly string[]
): BedrockInferenceRoutes {
  const byRegion = new Map<string, BedrockGeoPrefix>();
  for (const [prefix, regions] of Object.entries(geo) as [BedrockGeoPrefix, readonly string[]][]) {
    for (const region of regions) {
      if (byRegion.has(region)) {
        throw new Error(`Bedrock region ${region} is a source of two geo profiles`);
      }
      byRegion.set(region, prefix);
    }
  }
  return { geo: byRegion, global: new Set(global) };
}

/**
 * Per-model routes transcribed from each model's AWS card (see the header).
 * Every Bedrock catalog id has a row, and so does every older id this module
 * has routed before (Opus 4.1/4.5/4.6/4.7, Sonnet 4.5, DeepSeek R1); the spec
 * holds that partition against the catalog.
 */
export const BEDROCK_INFERENCE_ROUTES: ReadonlyMap<string, BedrockInferenceRoutes> = new Map([
  // model-card-amazon-nova-2-lite
  [
    'amazon.nova-2-lite-v1:0',
    routes(
      {
        eu: ['eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-3'],
        jp: ['ap-northeast-1'],
        us: ['ca-central-1', 'ca-west-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
      },
      [
        'ap-east-2',
        'ap-northeast-2',
        'ap-south-1',
        'ap-southeast-1',
        'ap-southeast-2',
        'ap-southeast-3',
        'ap-southeast-4',
        'ap-southeast-5',
        'ap-southeast-6',
        'ap-southeast-7',
        'eu-west-2',
        'il-central-1',
        'me-central-1',
      ]
    ),
  ],
  // model-card-amazon-nova-lite
  [
    'amazon.nova-lite-v1:0',
    routes(
      {
        apac: [
          'ap-east-2',
          'ap-northeast-1',
          'ap-northeast-2',
          'ap-south-1',
          'ap-southeast-1',
          'ap-southeast-2',
          'ap-southeast-3',
          'ap-southeast-4',
          'ap-southeast-5',
          'ap-southeast-7',
        ],
        ca: ['ca-central-1', 'ca-west-1'],
        eu: [
          'eu-central-1',
          'eu-north-1',
          'eu-south-1',
          'eu-south-2',
          'eu-west-1',
          'eu-west-3',
          'il-central-1',
        ],
        us: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
      },
      []
    ),
  ],
  // model-card-amazon-nova-micro
  [
    'amazon.nova-micro-v1:0',
    routes(
      {
        eu: [
          'eu-central-1',
          'eu-north-1',
          'eu-south-1',
          'eu-south-2',
          'eu-west-1',
          'eu-west-3',
          'il-central-1',
        ],
        us: ['us-east-1', 'us-east-2', 'us-west-2'],
      },
      []
    ),
  ],
  // model-card-amazon-nova-pro
  [
    'amazon.nova-pro-v1:0',
    routes(
      {
        apac: [
          'ap-east-2',
          'ap-northeast-1',
          'ap-northeast-2',
          'ap-south-1',
          'ap-southeast-1',
          'ap-southeast-2',
          'ap-southeast-3',
          'ap-southeast-4',
          'ap-southeast-5',
          'ap-southeast-7',
          'me-central-1',
        ],
        eu: [
          'eu-central-1',
          'eu-north-1',
          'eu-south-1',
          'eu-south-2',
          'eu-west-1',
          'eu-west-3',
          'il-central-1',
        ],
        us: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
      },
      []
    ),
  ],
  // model-card-anthropic-claude-fable-5
  [
    'anthropic.claude-fable-5',
    routes(
      { us: ['ca-central-1', 'ca-west-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'] },
      [
        'af-south-1',
        'ap-east-2',
        'ap-northeast-1',
        'ap-northeast-2',
        'ap-northeast-3',
        'ap-south-1',
        'ap-south-2',
        'ap-southeast-1',
        'ap-southeast-2',
        'ap-southeast-3',
        'ap-southeast-4',
        'ap-southeast-5',
        'ap-southeast-6',
        'ap-southeast-7',
        'eu-central-1',
        'eu-central-2',
        'eu-north-1',
        'eu-south-1',
        'eu-south-2',
        'eu-west-1',
        'eu-west-2',
        'eu-west-3',
        'il-central-1',
        'me-central-1',
        'me-south-1',
        'mx-central-1',
        'sa-east-1',
      ]
    ),
  ],
  // model-card-anthropic-claude-fable-5-1
  [
    'anthropic.claude-fable-5-1',
    routes(
      { us: ['ca-central-1', 'ca-west-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'] },
      [
        'af-south-1',
        'ap-east-2',
        'ap-northeast-1',
        'ap-northeast-2',
        'ap-northeast-3',
        'ap-south-1',
        'ap-south-2',
        'ap-southeast-1',
        'ap-southeast-2',
        'ap-southeast-3',
        'ap-southeast-4',
        'ap-southeast-5',
        'ap-southeast-6',
        'ap-southeast-7',
        'eu-central-1',
        'eu-central-2',
        'eu-north-1',
        'eu-south-1',
        'eu-south-2',
        'eu-west-1',
        'eu-west-2',
        'eu-west-3',
        'il-central-1',
        'me-central-1',
        'me-south-1',
        'mx-central-1',
        'sa-east-1',
      ]
    ),
  ],
  // model-card-anthropic-claude-haiku-4-5
  [
    'anthropic.claude-haiku-4-5-20251001-v1:0',
    routes(
      {
        au: ['ap-southeast-2', 'ap-southeast-4', 'ap-southeast-6'],
        eu: [
          'eu-central-1',
          'eu-central-2',
          'eu-north-1',
          'eu-south-1',
          'eu-south-2',
          'eu-west-1',
          'eu-west-2',
          'eu-west-3',
        ],
        in: ['ap-south-1', 'ap-south-2'],
        jp: ['ap-northeast-1', 'ap-northeast-3'],
        us: ['ca-central-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
      },
      [
        'af-south-1',
        'ap-east-2',
        'ap-northeast-2',
        'ap-southeast-1',
        'ap-southeast-3',
        'ap-southeast-5',
        'ap-southeast-7',
        'ca-west-1',
        'il-central-1',
        'me-central-1',
        'me-south-1',
        'mx-central-1',
        'sa-east-1',
      ]
    ),
  ],
  // model-card-anthropic-claude-opus-4-1
  [
    'anthropic.claude-opus-4-1-20250805-v1:0',
    routes({ us: ['us-east-1', 'us-east-2', 'us-west-2'] }, []),
  ],
  // model-card-anthropic-claude-opus-4-5
  [
    'anthropic.claude-opus-4-5-20251101-v1:0',
    routes(
      {
        eu: [
          'eu-central-1',
          'eu-central-2',
          'eu-north-1',
          'eu-south-1',
          'eu-south-2',
          'eu-west-1',
          'eu-west-2',
          'eu-west-3',
        ],
        us: ['ca-central-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
      },
      [
        'af-south-1',
        'ap-east-2',
        'ap-northeast-1',
        'ap-northeast-2',
        'ap-northeast-3',
        'ap-south-1',
        'ap-south-2',
        'ap-southeast-1',
        'ap-southeast-2',
        'ap-southeast-3',
        'ap-southeast-4',
        'ap-southeast-5',
        'ap-southeast-6',
        'ap-southeast-7',
        'ca-west-1',
        'il-central-1',
        'me-central-1',
        'me-south-1',
        'mx-central-1',
        'sa-east-1',
      ]
    ),
  ],
  // model-card-anthropic-claude-opus-4-6
  [
    'anthropic.claude-opus-4-6-v1',
    routes(
      {
        au: ['ap-southeast-2', 'ap-southeast-4', 'ap-southeast-6'],
        eu: [
          'eu-central-1',
          'eu-central-2',
          'eu-north-1',
          'eu-south-1',
          'eu-south-2',
          'eu-west-1',
          'eu-west-2',
          'eu-west-3',
        ],
        us: ['ca-central-1', 'ca-west-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
      },
      [
        'af-south-1',
        'ap-east-2',
        'ap-northeast-1',
        'ap-northeast-2',
        'ap-northeast-3',
        'ap-south-1',
        'ap-south-2',
        'ap-southeast-1',
        'ap-southeast-3',
        'ap-southeast-5',
        'ap-southeast-7',
        'il-central-1',
        'me-central-1',
        'me-south-1',
        'mx-central-1',
        'sa-east-1',
      ]
    ),
  ],
  // model-card-anthropic-claude-opus-4-7
  [
    'anthropic.claude-opus-4-7',
    routes(
      {
        au: ['ap-southeast-2', 'ap-southeast-4'],
        eu: [
          'eu-central-1',
          'eu-central-2',
          'eu-north-1',
          'eu-south-1',
          'eu-south-2',
          'eu-west-1',
          'eu-west-2',
          'eu-west-3',
        ],
        jp: ['ap-northeast-1', 'ap-northeast-3'],
        us: ['ca-central-1', 'ca-west-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
      },
      [
        'af-south-1',
        'ap-east-2',
        'ap-northeast-2',
        'ap-south-1',
        'ap-south-2',
        'ap-southeast-1',
        'ap-southeast-3',
        'ap-southeast-5',
        'ap-southeast-6',
        'ap-southeast-7',
        'il-central-1',
        'me-central-1',
        'me-south-1',
        'mx-central-1',
        'sa-east-1',
      ]
    ),
  ],
  // model-card-anthropic-claude-opus-4-8
  [
    'anthropic.claude-opus-4-8',
    routes(
      {
        au: ['ap-southeast-2', 'ap-southeast-4'],
        eu: [
          'eu-central-1',
          'eu-central-2',
          'eu-north-1',
          'eu-south-1',
          'eu-south-2',
          'eu-west-1',
          'eu-west-2',
          'eu-west-3',
        ],
        jp: ['ap-northeast-1', 'ap-northeast-3'],
        us: ['ca-central-1', 'ca-west-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
      },
      [
        'af-south-1',
        'ap-east-2',
        'ap-northeast-2',
        'ap-south-1',
        'ap-south-2',
        'ap-southeast-1',
        'ap-southeast-3',
        'ap-southeast-5',
        'ap-southeast-6',
        'ap-southeast-7',
        'il-central-1',
        'me-central-1',
        'me-south-1',
        'mx-central-1',
        'sa-east-1',
      ]
    ),
  ],
  // model-card-anthropic-claude-opus-5
  [
    'anthropic.claude-opus-5',
    routes(
      {
        au: ['ap-southeast-2', 'ap-southeast-4'],
        eu: [
          'eu-central-1',
          'eu-central-2',
          'eu-north-1',
          'eu-south-1',
          'eu-south-2',
          'eu-west-1',
          'eu-west-2',
          'eu-west-3',
        ],
        in: ['ap-south-1', 'ap-south-2'],
        us: ['ca-central-1', 'ca-west-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
      },
      [
        'af-south-1',
        'ap-east-2',
        'ap-northeast-1',
        'ap-northeast-2',
        'ap-northeast-3',
        'ap-southeast-1',
        'ap-southeast-3',
        'ap-southeast-5',
        'ap-southeast-6',
        'ap-southeast-7',
        'il-central-1',
        'me-central-1',
        'me-south-1',
        'mx-central-1',
        'sa-east-1',
      ]
    ),
  ],
  // model-card-anthropic-claude-opus-5-5
  [
    'anthropic.claude-opus-5-5',
    routes(
      {
        au: ['ap-southeast-2', 'ap-southeast-4'],
        eu: [
          'eu-central-1',
          'eu-central-2',
          'eu-north-1',
          'eu-south-1',
          'eu-south-2',
          'eu-west-1',
          'eu-west-2',
          'eu-west-3',
        ],
        jp: ['ap-northeast-1', 'ap-northeast-3'],
        us: ['ca-central-1', 'ca-west-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
      },
      [
        'af-south-1',
        'ap-east-2',
        'ap-northeast-2',
        'ap-south-1',
        'ap-south-2',
        'ap-southeast-1',
        'ap-southeast-3',
        'ap-southeast-5',
        'ap-southeast-6',
        'ap-southeast-7',
        'il-central-1',
        'me-central-1',
        'me-south-1',
        'mx-central-1',
        'sa-east-1',
      ]
    ),
  ],
  // model-card-anthropic-claude-sonnet-4-5
  [
    'anthropic.claude-sonnet-4-5-20250929-v1:0',
    routes(
      {
        au: ['ap-southeast-2', 'ap-southeast-4', 'ap-southeast-6'],
        eu: [
          'eu-central-1',
          'eu-central-2',
          'eu-north-1',
          'eu-south-1',
          'eu-south-2',
          'eu-west-1',
          'eu-west-2',
          'eu-west-3',
        ],
        jp: ['ap-northeast-1', 'ap-northeast-3'],
        us: ['ca-central-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
      },
      [
        'af-south-1',
        'ap-east-2',
        'ap-northeast-2',
        'ap-south-1',
        'ap-south-2',
        'ap-southeast-1',
        'ap-southeast-3',
        'ap-southeast-5',
        'ap-southeast-7',
        'ca-west-1',
        'il-central-1',
        'me-central-1',
        'me-south-1',
        'mx-central-1',
        'sa-east-1',
      ]
    ),
  ],
  // model-card-anthropic-claude-sonnet-4-6
  [
    'anthropic.claude-sonnet-4-6',
    routes(
      {
        au: ['ap-southeast-2', 'ap-southeast-4', 'ap-southeast-6'],
        eu: [
          'eu-central-1',
          'eu-central-2',
          'eu-north-1',
          'eu-south-1',
          'eu-south-2',
          'eu-west-1',
          'eu-west-2',
          'eu-west-3',
        ],
        jp: ['ap-northeast-1', 'ap-northeast-3'],
        us: ['ca-central-1', 'ca-west-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
      },
      [
        'af-south-1',
        'ap-east-2',
        'ap-northeast-2',
        'ap-south-1',
        'ap-south-2',
        'ap-southeast-1',
        'ap-southeast-3',
        'ap-southeast-5',
        'ap-southeast-7',
        'il-central-1',
        'me-central-1',
        'me-south-1',
        'mx-central-1',
        'sa-east-1',
      ]
    ),
  ],
  // model-card-anthropic-claude-sonnet-5
  [
    'anthropic.claude-sonnet-5',
    routes(
      {
        au: ['ap-southeast-2', 'ap-southeast-4'],
        eu: [
          'eu-central-1',
          'eu-central-2',
          'eu-north-1',
          'eu-south-1',
          'eu-south-2',
          'eu-west-1',
          'eu-west-2',
          'eu-west-3',
        ],
        in: ['ap-south-1', 'ap-south-2'],
        us: ['ca-central-1', 'ca-west-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
      },
      [
        'af-south-1',
        'ap-east-2',
        'ap-northeast-1',
        'ap-northeast-2',
        'ap-northeast-3',
        'ap-southeast-1',
        'ap-southeast-3',
        'ap-southeast-5',
        'ap-southeast-6',
        'ap-southeast-7',
        'il-central-1',
        'me-central-1',
        'me-south-1',
        'mx-central-1',
        'sa-east-1',
      ]
    ),
  ],
  // model-card-deepseek-deepseek-r1
  ['deepseek.r1-v1:0', routes({ us: ['us-east-1', 'us-east-2', 'us-west-2'] }, [])],
  // model-card-deepseek-deepseek-v3-2
  ['deepseek.v3.2', routes({}, [])],
  // model-card-meta-llama-4-maverick-17b-instruct
  [
    'meta.llama4-maverick-17b-instruct-v1:0',
    routes({ us: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'] }, []),
  ],
  // model-card-meta-llama-4-scout-17b-instruct
  [
    'meta.llama4-scout-17b-instruct-v1:0',
    routes({ us: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'] }, []),
  ],
]);

/**
 * Strip a cross-region inference-profile prefix, returning the CATALOG id.
 *
 * Exported for the CAPABILITY lookups (prompt caching, reasoning dialect),
 * which are keyed on the unprefixed catalog id. `createProvider` accepts an
 * already-prefixed id and passes it through (BST-1350 contract, pinned by
 * provider-factory.bedrock.spec.ts), so a routed id genuinely does reach those
 * lookups — and a raw miss would silently cost that route BOTH prompt caching
 * and its reasoning dialect. Resolving the prefix away is the fix; the prefix
 * selects a region, it never changes what the model supports.
 */
export function stripCrossRegionPrefix(modelId: string): string {
  const prefix = CROSS_REGION_PREFIXES.find((candidate) => modelId.startsWith(candidate));
  return prefix ? modelId.slice(prefix.length) : modelId;
}

export function resolveBedrockModelId(modelId: string, region: string): string {
  if (CROSS_REGION_PREFIXES.some((prefix) => modelId.startsWith(prefix))) {
    return modelId;
  }
  const routesForModel = BEDROCK_INFERENCE_ROUTES.get(modelId);
  if (!routesForModel || region.startsWith('us-gov-')) {
    return modelId;
  }
  const geo = routesForModel.geo.get(region);
  if (geo) {
    return `${geo}.${modelId}`;
  }
  return routesForModel.global.has(region) ? `global.${modelId}` : modelId;
}
