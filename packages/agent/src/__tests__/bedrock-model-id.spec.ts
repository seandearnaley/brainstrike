import { describe, expect, it } from 'vitest';
import { resolveBedrockModelId } from '../providers/bedrock-model-id';

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
      // Fable 5.1 has a us. profile but NO eu. one (models.dev, 2026-09-08),
      // so eu regions send it verbatim rather than guessing a profile.
      expect(resolveBedrockModelId('anthropic.claude-fable-5-1', 'eu-west-1')).toBe(
        'anthropic.claude-fable-5-1'
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

    it('leaves fable-5 unprefixed in au — models.dev lists no au./apac. profile for it', () => {
      expect(resolveBedrockModelId('anthropic.claude-fable-5', 'ap-southeast-2')).toBe(
        'anthropic.claude-fable-5'
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

    it('leaves fable-5 and nova unprefixed in jp', () => {
      expect(resolveBedrockModelId('anthropic.claude-fable-5', 'ap-northeast-1')).toBe(
        'anthropic.claude-fable-5'
      );
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
    it('leaves opus-5 unprefixed in jp — AWS publishes no jp. profile for it', () => {
      expect(resolveBedrockModelId('anthropic.claude-opus-5', 'ap-northeast-1')).toBe(
        'anthropic.claude-opus-5'
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
     * Global ✓. The card outranks models.dev, so Tokyo sends the id verbatim.
     */
    it('leaves sonnet-5 unprefixed in jp — AWS publishes no jp. profile for it', () => {
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'ap-northeast-1')).toBe(
        'anthropic.claude-sonnet-5'
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
    it('never emits apac. — models.dev lists no apac. profiles at all today', () => {
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'ap-south-1')).toBe(
        'anthropic.claude-sonnet-5'
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
    it('never prefixes outside the mapped groups', () => {
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'ca-central-1')).toBe(
        'anthropic.claude-sonnet-5'
      );
      expect(resolveBedrockModelId('amazon.nova-pro-v1:0', 'sa-east-1')).toBe(
        'amazon.nova-pro-v1:0'
      );
      expect(resolveBedrockModelId('anthropic.claude-fable-5', 'me-south-1')).toBe(
        'anthropic.claude-fable-5'
      );
    });
  });
});
