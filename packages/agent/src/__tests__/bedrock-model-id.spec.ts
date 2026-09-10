import { listProviderLlmModels } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_PROFILE_REGIONS_BY_MODEL,
  NO_GLOBAL_PROFILE_MODEL_IDS,
  PROFILE_MODEL_IDS_BY_GROUP,
  resolveBedrockModelId,
} from '../providers/bedrock-model-id';

/**
 * BST-1350 (revised per PR #2522 review, finding 2/3): cross-region
 * inference-profile prefixing is derived from models.dev GROUND TRUTH
 * (amazon-bedrock provider, retrieved 2026-08-18) — a prefix is emitted only
 * when models.dev lists that exact regional profile id. When no regional
 * profile exists for a model+region, the id passes through UNPREFIXED and
 * Bedrock itself reports the routing outcome. Already-prefixed ids are NEVER
 * double-prefixed.
 */
describe('resolveBedrockModelId', () => {
  describe('never double-prefixes an already-prefixed id', () => {
    const prefixed = [
      'global.anthropic.claude-opus-4-5-20251101-v1:0',
      'us.anthropic.claude-sonnet-5',
      'eu.anthropic.claude-opus-4-8',
      'jp.anthropic.claude-sonnet-4-6',
      'apac.amazon.nova-pro-v1:0',
      'au.anthropic.claude-haiku-4-5-20251001-v1:0',
    ];
    for (const id of prefixed) {
      it(`passes ${id} through in every region`, () => {
        expect(resolveBedrockModelId(id, 'us-east-1')).toBe(id);
        expect(resolveBedrockModelId(id, 'eu-west-1')).toBe(id);
        expect(resolveBedrockModelId(id, 'ap-southeast-2')).toBe(id);
      });
    }
  });

  describe('us regions', () => {
    const usProfileIds = [
      'anthropic.claude-fable-5',
      'anthropic.claude-fable-5-1',
      'anthropic.claude-opus-4-8',
      'anthropic.claude-sonnet-5',
      'anthropic.claude-sonnet-4-6',
      'anthropic.claude-haiku-4-5-20251001-v1:0',
      'deepseek.r1-v1:0',
      'meta.llama4-maverick-17b-instruct-v1:0',
      'meta.llama4-scout-17b-instruct-v1:0',
    ];

    it('prefixes exactly the models with a us. profile (claude, deepseek r1, llama4)', () => {
      for (const id of usProfileIds) {
        expect(resolveBedrockModelId(id, 'us-east-1')).toBe(`us.${id}`);
        expect(resolveBedrockModelId(id, 'us-west-2')).toBe(`us.${id}`);
      }
    });

    it('leaves models WITHOUT a us. profile unprefixed (nova, deepseek v3.2)', () => {
      // models.dev lists NO us.amazon.nova-* and no us.deepseek.v3.2 —
      // the previously shipped substring table over-prefixed both families.
      expect(resolveBedrockModelId('amazon.nova-pro-v1:0', 'us-east-1')).toBe(
        'amazon.nova-pro-v1:0'
      );
      expect(resolveBedrockModelId('amazon.nova-lite-v1:0', 'us-east-1')).toBe(
        'amazon.nova-lite-v1:0'
      );
      expect(resolveBedrockModelId('amazon.nova-micro-v1:0', 'us-west-2')).toBe(
        'amazon.nova-micro-v1:0'
      );
      expect(resolveBedrockModelId('deepseek.v3.2', 'us-east-1')).toBe('deepseek.v3.2');
      expect(resolveBedrockModelId('cohere.command-r-plus-v1:0', 'us-east-1')).toBe(
        'cohere.command-r-plus-v1:0'
      );
    });

    it('excludes us-gov regions from the us. prefix', () => {
      for (const id of usProfileIds) {
        expect(resolveBedrockModelId(id, 'us-gov-west-1')).toBe(id);
        expect(resolveBedrockModelId(id, 'us-gov-east-1')).toBe(id);
      }
    });
  });

  describe('eu regions', () => {
    it('prefixes the claude family (the only eu.-profiled family) in listed eu regions', () => {
      for (const region of [
        'eu-west-1',
        'eu-west-2',
        'eu-west-3',
        'eu-north-1',
        'eu-central-1',
        'eu-south-1',
        'eu-south-2',
      ]) {
        expect(resolveBedrockModelId('anthropic.claude-sonnet-5', region)).toBe(
          'eu.anthropic.claude-sonnet-5'
        );
      }
      expect(resolveBedrockModelId('anthropic.claude-fable-5', 'eu-west-1')).toBe(
        'eu.anthropic.claude-fable-5'
      );
      // Fable 5.1 has a us. profile but NO eu. one — confirmed on its card,
      // which marks every EU region Geo ✗ / Global ✓. Since BST-1711 those
      // regions take the GLOBAL profile the card does publish, instead of the
      // uninvocable verbatim id.
      expect(resolveBedrockModelId('anthropic.claude-fable-5-1', 'eu-west-1')).toBe(
        'global.anthropic.claude-fable-5-1'
      );
      expect(
        resolveBedrockModelId('anthropic.claude-haiku-4-5-20251001-v1:0', 'eu-central-1')
      ).toBe('eu.anthropic.claude-haiku-4-5-20251001-v1:0');
    });

    it('leaves non-claude models unprefixed in eu (models.dev lists no eu. profiles for them)', () => {
      // The opencode-era table prefixed nova-lite/micro, llama3, and pixtral
      // in eu; models.dev lists no such eu. profiles today.
      expect(resolveBedrockModelId('amazon.nova-lite-v1:0', 'eu-west-1')).toBe(
        'amazon.nova-lite-v1:0'
      );
      expect(resolveBedrockModelId('amazon.nova-micro-v1:0', 'eu-central-1')).toBe(
        'amazon.nova-micro-v1:0'
      );
      expect(resolveBedrockModelId('meta.llama3-1-70b-instruct-v1:0', 'eu-west-2')).toBe(
        'meta.llama3-1-70b-instruct-v1:0'
      );
      expect(resolveBedrockModelId('mistral.pixtral-large-2502-v1:0', 'eu-north-1')).toBe(
        'mistral.pixtral-large-2502-v1:0'
      );
    });

    it('leaves unlisted eu regions unprefixed', () => {
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'eu-central-2')).toBe(
        'anthropic.claude-sonnet-5'
      );
    });
  });

  describe('au regions (ap-southeast-2/4)', () => {
    /**
     * `anthropic.claude-opus-4-7` was MISSING from the au. set until BST-1710's
     * card audit: its card publishes `au.anthropic.claude-opus-4-7` and marks
     * ap-southeast-2/-4 Geo ✓, while marking the bare id In-Region ✗ in every
     * region — so Sydney and Melbourne were being handed an id Bedrock cannot
     * invoke. The audit cuts BOTH ways: drop the profiles AWS does not publish,
     * emit the ones it does.
     */
    it('prefixes the claude models that HAVE au. profiles', () => {
      for (const id of [
        'anthropic.claude-sonnet-5',
        'anthropic.claude-sonnet-4-6',
        'anthropic.claude-opus-4-7',
        'anthropic.claude-opus-4-8',
        'anthropic.claude-haiku-4-5-20251001-v1:0',
      ]) {
        expect(resolveBedrockModelId(id, 'ap-southeast-2')).toBe(`au.${id}`);
        expect(resolveBedrockModelId(id, 'ap-southeast-4')).toBe(`au.${id}`);
      }
    });

    it('routes fable-5 through global. in au — its card publishes no au. profile', () => {
      // No au./apac. profile on models.dev OR on the card, which marks
      // ap-southeast-2 Geo ✗ / Global ✓ — so global. is the invocable route.
      expect(resolveBedrockModelId('anthropic.claude-fable-5', 'ap-southeast-2')).toBe(
        'global.anthropic.claude-fable-5'
      );
    });

    it('leaves nova unprefixed in au', () => {
      expect(resolveBedrockModelId('amazon.nova-pro-v1:0', 'ap-southeast-2')).toBe(
        'amazon.nova-pro-v1:0'
      );
    });
  });

  describe('jp region (ap-northeast-1)', () => {
    /**
     * BST-1710: every id below was checked against its OWN AWS model card
     * (retrieved 2026-09-10). Each card's Programmatic Access row lists a
     * `jp.<id>` Geo inference ID and carries a "Geo: JP" section sourced from
     * ap-northeast-1, so these are AWS-PUBLISHED profiles — not mirror guesses.
     */
    it('prefixes the claude models whose CARD publishes a jp. profile', () => {
      for (const id of [
        'anthropic.claude-opus-4-7',
        'anthropic.claude-opus-4-8',
        'anthropic.claude-sonnet-4-5-20250929-v1:0',
        'anthropic.claude-sonnet-4-6',
        'anthropic.claude-haiku-4-5-20251001-v1:0',
      ]) {
        expect(resolveBedrockModelId(id, 'ap-northeast-1')).toBe(`jp.${id}`);
      }
    });

    it('routes fable-5 through global. in jp, and leaves nova alone entirely', () => {
      // Fable 5 has no jp. profile; its card marks ap-northeast-1
      // Geo ✗ / Global ✓, so global. is the invocable route.
      expect(resolveBedrockModelId('anthropic.claude-fable-5', 'ap-northeast-1')).toBe(
        'global.anthropic.claude-fable-5'
      );
      // Nova has no geo profile AND no global inference id — stays verbatim.
      expect(resolveBedrockModelId('amazon.nova-pro-v1:0', 'ap-northeast-1')).toBe(
        'amazon.nova-pro-v1:0'
      );
    });

    /**
     * BST-1694 (PR #3080 review): models.dev lists a `jp.anthropic.claude-opus-5`
     * profile that AWS does NOT publish. The Opus 5 model card's Programmatic
     * Access / Data residency tables give exactly `anthropic.claude-opus-5`,
     * `us.`, `eu.`, `au.` and `global.` — no `jp.` — and list ap-northeast-1 as
     * Global-only. Emitting `jp.` there would target a profile that does not
     * exist; the AWS card outranks models.dev, so the id passes through
     * verbatim and Bedrock reports the routing outcome (module contract).
     */
    it('never emits jp. for opus-5, and since BST-1711 routes it global. instead', () => {
      // BST-1694 stopped the phantom `jp.` emission; the id then fell through
      // VERBATIM, which that card marks In-Region ✗ — still uninvocable.
      // BST-1711 completes it: ap-northeast-1 is Geo ✗ / Global ✓ on the Opus 5
      // card, so Tokyo now gets the global profile AWS actually publishes.
      expect(resolveBedrockModelId('anthropic.claude-opus-5', 'ap-northeast-1')).toBe(
        'global.anthropic.claude-opus-5'
      );
    });

    /**
     * BST-1710: the SAME models.dev phantom as opus-5, one model later. The
     * Claude Sonnet 5 card
     * (docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html,
     * retrieved 2026-09-10) gives Geo inference IDs `us.anthropic.claude-sonnet-5`,
     * `eu.anthropic.claude-sonnet-5`, `au.anthropic.claude-sonnet-5` and Global
     * `global.anthropic.claude-sonnet-5` — no `jp.` anywhere, no "Geo: JP"
     * section, and its regional table marks ap-northeast-1 In-Region ✗ / Geo ✗ /
     * Global ✓. The card outranks models.dev, so Tokyo never gets `jp.`.
     *
     * MERGE NOTE (BST-1711): when BST-1710 landed, dropping the phantom left
     * Tokyo on the VERBATIM id, which the same card marks In-Region ✗ — still
     * uninvocable, and that is exactly the row this ticket exists to close.
     * `global.` is the route the card publishes for ap-northeast-1, so the
     * expectation moves from the verbatim id to the global profile. Same
     * ruling, one step further.
     */
    it('never emits jp. for sonnet-5, and since BST-1711 routes it global. instead', () => {
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'ap-northeast-1')).toBe(
        'global.anthropic.claude-sonnet-5'
      );
    });

    it('still emits the us./eu./au. profiles the sonnet-5 card DOES publish', () => {
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'us-east-1')).toBe(
        'us.anthropic.claude-sonnet-5'
      );
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'eu-west-1')).toBe(
        'eu.anthropic.claude-sonnet-5'
      );
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'ap-southeast-2')).toBe(
        'au.anthropic.claude-sonnet-5'
      );
    });

    it('still emits the us./eu./au. profiles the opus-5 card DOES publish', () => {
      expect(resolveBedrockModelId('anthropic.claude-opus-5', 'us-east-1')).toBe(
        'us.anthropic.claude-opus-5'
      );
      expect(resolveBedrockModelId('anthropic.claude-opus-5', 'eu-west-1')).toBe(
        'eu.anthropic.claude-opus-5'
      );
      expect(resolveBedrockModelId('anthropic.claude-opus-5', 'ap-southeast-2')).toBe(
        'au.anthropic.claude-opus-5'
      );
    });
  });

  describe('other ap regions', () => {
    it('never emits apac. — no apac. profile exists on any card or on models.dev', () => {
      // ap-south-1 now takes the GLOBAL profile (its card row is Geo ✗ /
      // Global ✓), never an invented `apac.` one.
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'ap-south-1')).toBe(
        'global.anthropic.claude-sonnet-5'
      );
      expect(resolveBedrockModelId('amazon.nova-lite-v1:0', 'ap-southeast-1')).toBe(
        'amazon.nova-lite-v1:0'
      );
      expect(resolveBedrockModelId('amazon.nova-micro-v1:0', 'ap-northeast-2')).toBe(
        'amazon.nova-micro-v1:0'
      );
    });
  });

  describe('other regions', () => {
    it('leaves models with no profile of any kind unprefixed', () => {
      // Nova has no us./eu./au./jp. profile AND no global inference id.
      expect(resolveBedrockModelId('amazon.nova-pro-v1:0', 'sa-east-1')).toBe(
        'amazon.nova-pro-v1:0'
      );
      // ca-central-1 is Geo ✓ on the Sonnet 5 card, so it is NOT in the
      // global-only set; the geo map does not reach it yet, so it stays
      // verbatim (documented under-emission, BST-1711 follow-up).
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'ca-central-1')).toBe(
        'anthropic.claude-sonnet-5'
      );
    });
  });

  /**
   * BST-1711. The Claude cards mark the BASE id In-Region ✗ in every region,
   * so a geo or global profile is mandatory and the verbatim id is not
   * invocable. This module previously emitted no `global.` at all, leaving
   * every Geo ✗ / Global ✓ region with an id Bedrock cannot answer.
   *
   * Regions and ids below are transcribed from each model's own card
   * (Regional Availability, bedrock-runtime), retrieved 2026-09-10.
   */
  describe('global profile routing', () => {
    it('routes Tokyo through global. for the models whose card has no JP geo', () => {
      // The ticket's worked example: Opus 5's card lists us./eu./au. geo ids
      // and global., and marks ap-northeast-1 In-Region ✗ / Geo ✗ / Global ✓.
      expect(resolveBedrockModelId('anthropic.claude-opus-5', 'ap-northeast-1')).toBe(
        'global.anthropic.claude-opus-5'
      );
      expect(
        resolveBedrockModelId('anthropic.claude-opus-4-5-20251101-v1:0', 'ap-northeast-1')
      ).toBe('global.anthropic.claude-opus-4-5-20251101-v1:0');
      expect(resolveBedrockModelId('anthropic.claude-opus-4-6-v1', 'ap-northeast-1')).toBe(
        'global.anthropic.claude-opus-4-6-v1'
      );
    });

    it('prefers the GEO profile over global. wherever the card publishes one', () => {
      // Data residency is the stronger guarantee, so these keep their geo id
      // even though the same card also marks the region Global ✓.
      expect(resolveBedrockModelId('anthropic.claude-opus-5', 'us-east-1')).toBe(
        'us.anthropic.claude-opus-5'
      );
      expect(resolveBedrockModelId('anthropic.claude-opus-5', 'eu-west-1')).toBe(
        'eu.anthropic.claude-opus-5'
      );
      expect(resolveBedrockModelId('anthropic.claude-opus-5', 'ap-southeast-2')).toBe(
        'au.anthropic.claude-opus-5'
      );
      // Opus 4.7 HAS a jp. profile, so Tokyo stays geo rather than going global.
      expect(resolveBedrockModelId('anthropic.claude-opus-4-7', 'ap-northeast-1')).toBe(
        'jp.anthropic.claude-opus-4-7'
      );
    });

    it('never emits global. in GovCloud — every card that lists it marks Global ✗', () => {
      for (const id of [
        'anthropic.claude-opus-5',
        'anthropic.claude-sonnet-5',
        'anthropic.claude-fable-5-1',
        'anthropic.claude-sonnet-4-5-20250929-v1:0',
        'anthropic.claude-haiku-4-5-20251001-v1:0',
      ]) {
        expect(resolveBedrockModelId(id, 'us-gov-west-1')).toBe(id);
        expect(resolveBedrockModelId(id, 'us-gov-east-1')).toBe(id);
      }
    });

    it('never emits global. for a model whose card publishes no Global inference id', () => {
      // Opus 4.1's card reads "N/A"; deepseek r1 and both llama4 routes read
      // "Not supported". They must stay verbatim everywhere off their us. geo.
      for (const id of [
        'anthropic.claude-opus-4-1-20250805-v1:0',
        'deepseek.r1-v1:0',
        'meta.llama4-maverick-17b-instruct-v1:0',
        'meta.llama4-scout-17b-instruct-v1:0',
      ]) {
        expect(resolveBedrockModelId(id, 'ap-northeast-1')).toBe(id);
        expect(resolveBedrockModelId(id, 'sa-east-1')).toBe(id);
        expect(resolveBedrockModelId(id, 'me-south-1')).toBe(id);
      }
    });

    it('covers the core Geo ✗ / Global ✓ region class every global card shares', () => {
      for (const region of [
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
      ]) {
        expect(resolveBedrockModelId('anthropic.claude-sonnet-4-6', region)).toBe(
          'global.anthropic.claude-sonnet-4-6'
        );
      }
    });

    it('honours the per-model differences the cards actually publish', () => {
      // ap-southeast-6 (NZ): Geo ✗ for Opus 4.8, so it goes global. It is
      // Geo ✓ for Sonnet 4.6, so it is NOT global-only there — and because the
      // geo map does not reach NZ yet, Sonnet 4.6 stays verbatim (the
      // under-emission recorded in the module header for the follow-up).
      expect(resolveBedrockModelId('anthropic.claude-opus-4-8', 'ap-southeast-6')).toBe(
        'global.anthropic.claude-opus-4-8'
      );
      expect(resolveBedrockModelId('anthropic.claude-sonnet-4-6', 'ap-southeast-6')).toBe(
        'anthropic.claude-sonnet-4-6'
      );
      // ap-southeast-2 (Sydney): Opus 4.5's card publishes NO au. geo at all,
      // so Sydney is global-only for it while every other Claude routes au.
      expect(
        resolveBedrockModelId('anthropic.claude-opus-4-5-20251101-v1:0', 'ap-southeast-2')
      ).toBe('global.anthropic.claude-opus-4-5-20251101-v1:0');
      expect(resolveBedrockModelId('anthropic.claude-sonnet-4-6', 'ap-southeast-2')).toBe(
        'au.anthropic.claude-sonnet-4-6'
      );
      // ca-west-1: Geo ✗ on the Haiku 4.5 card, Geo ✓ on the Sonnet 5 card.
      expect(resolveBedrockModelId('anthropic.claude-haiku-4-5-20251001-v1:0', 'ca-west-1')).toBe(
        'global.anthropic.claude-haiku-4-5-20251001-v1:0'
      );
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'ca-west-1')).toBe(
        'anthropic.claude-sonnet-5'
      );
    });

    /**
     * PR #3118 review finding 4. `fable-5` is in EU_PROFILE_MODEL_IDS (a
     * suspected models.dev phantom — its card publishes `us.`/`global.` only)
     * while EU_PREFIX_REGIONS omits `eu-central-2`. The two facts together
     * split one model across one geography, which is newly introduced by this
     * ticket. Pinned so that closing the phantom has to change it on purpose.
     */
    it('splits fable-5 INSIDE the EU while the eu. phantom outlives the geo map', () => {
      // eu-west-1 IS mapped, so geo precedence keeps the (phantom) eu. id.
      expect(resolveBedrockModelId('anthropic.claude-fable-5', 'eu-west-1')).toBe(
        'eu.anthropic.claude-fable-5'
      );
      // eu-central-2 is NOT mapped, so the card's Geo ✗ / Global ✓ row wins.
      expect(resolveBedrockModelId('anthropic.claude-fable-5', 'eu-central-2')).toBe(
        'global.anthropic.claude-fable-5'
      );
    });

    it('routes the EU regions through global. for Fable 5.1, which has no eu. geo', () => {
      expect(resolveBedrockModelId('anthropic.claude-fable-5-1', 'eu-west-1')).toBe(
        'global.anthropic.claude-fable-5-1'
      );
      expect(resolveBedrockModelId('anthropic.claude-fable-5-1', 'eu-central-1')).toBe(
        'global.anthropic.claude-fable-5-1'
      );
    });

    it('never double-prefixes an id that already carries global.', () => {
      expect(resolveBedrockModelId('global.anthropic.claude-opus-5', 'ap-northeast-1')).toBe(
        'global.anthropic.claude-opus-5'
      );
    });
  });

  /**
   * PR #3118 review finding 1. `resolveBedrockModelId` checks geo BEFORE
   * global, so a (model, region) pair that is in the global table AND has a
   * geo profile for that region can never reach the global branch — the row is
   * dead. A dead row is not automatically wrong (a card that may change, or a
   * geo phantom already scheduled for removal, is a reason to keep one), but
   * it must be DECLARED. This iterates the entire table and fails on any pair
   * that is shadowed without being listed, which converts the module header's
   * prose caveat into a mechanical guard.
   *
   * Exactly one family qualifies today: `anthropic.claude-fable-5` in the seven
   * EU regions EU_PREFIX_REGIONS maps, because it sits in the `eu.` set even
   * though its card publishes `us.`/`global.` only (the BST-1710-class phantom
   * in the module's KNOWN GAPS). Its global rows stay, so that dropping the
   * phantom needs no second edit here.
   */
  describe('the global table carries no UNDECLARED dead rows', () => {
    const SHADOWED_MODEL_ID = 'anthropic.claude-fable-5';
    const SHADOWED_REGIONS = [
      'eu-central-1',
      'eu-north-1',
      'eu-south-1',
      'eu-south-2',
      'eu-west-1',
      'eu-west-2',
      'eu-west-3',
    ] as const;
    const KNOWN_SHADOWED_PAIRS: ReadonlySet<string> = new Set(
      SHADOWED_REGIONS.map((region) => `${SHADOWED_MODEL_ID} @ ${region}`)
    );

    it('every global entry either wins its region or is a declared shadowed pair', () => {
      const shadowed: string[] = [];
      for (const [modelId, regions] of GLOBAL_PROFILE_REGIONS_BY_MODEL) {
        for (const region of regions) {
          if (resolveBedrockModelId(modelId, region) !== `global.${modelId}`) {
            shadowed.push(`${modelId} @ ${region}`);
          }
        }
      }
      expect(shadowed.filter((pair) => !KNOWN_SHADOWED_PAIRS.has(pair)).sort()).toEqual([]);
    });

    it('every declared shadowed pair is STILL shadowed — delete it once it is not', () => {
      for (const region of SHADOWED_REGIONS) {
        expect(resolveBedrockModelId(SHADOWED_MODEL_ID, region)).toBe(`eu.${SHADOWED_MODEL_ID}`);
      }
    });
  });

  /**
   * PR #3118 review finding 2 — the REFRESH CONTRACT, which the module header
   * used to assert in prose ("the four such catalog ids") and nothing checked.
   * The claim was wrong in both directions: two of the four are not catalog ids
   * at all, and the catalog carries five more ids with no profile of any kind.
   *
   * The invariant that actually matters is a PARTITION: every id this module
   * names — each Bedrock catalog id, plus every member of the four geo sets —
   * belongs to exactly one of GLOBAL_PROFILE_REGIONS_BY_MODEL and
   * NO_GLOBAL_PROFILE_MODEL_IDS. Without it a newly added Claude id silently
   * gets no global routing and, since the cards mark the base id In-Region ✗
   * everywhere, is uninvocable outside its geo regions with no test to say so.
   *
   * `listProviderLlmModels` is the whole Bedrock catalog surface here — the
   * provider has no embedding models and `createEmbeddingProvider` throws for
   * it (documented exclusion in docs/agents/assistant-providers.md).
   */
  describe('global-routing classification covers every id the module names', () => {
    const namedIds: ReadonlySet<string> = new Set([
      ...listProviderLlmModels('bedrock').map((model) => model.id),
      ...Object.values(PROFILE_MODEL_IDS_BY_GROUP).flatMap((ids) => [...ids]),
    ]);

    it('puts each named id in exactly one of the two global tables', () => {
      const unclassified: string[] = [];
      const inBoth: string[] = [];
      for (const id of namedIds) {
        const hasGlobalRegions = GLOBAL_PROFILE_REGIONS_BY_MODEL.has(id);
        const declaredNoGlobal = NO_GLOBAL_PROFILE_MODEL_IDS.has(id);
        if (hasGlobalRegions && declaredNoGlobal) {
          inBoth.push(id);
        } else if (!(hasGlobalRegions || declaredNoGlobal)) {
          unclassified.push(id);
        }
      }
      expect({ inBoth: inBoth.sort(), unclassified: unclassified.sort() }).toEqual({
        inBoth: [],
        unclassified: [],
      });
    });

    it('classifies no id the module does not name — stale rows fail too', () => {
      const stale = [
        ...GLOBAL_PROFILE_REGIONS_BY_MODEL.keys(),
        ...NO_GLOBAL_PROFILE_MODEL_IDS,
      ].filter((id) => !namedIds.has(id));
      expect(stale.sort()).toEqual([]);
    });
  });
});
