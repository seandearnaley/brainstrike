import { listProviderLlmModels } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  BEDROCK_INFERENCE_ROUTES,
  resolveBedrockModelId,
  stripCrossRegionPrefix,
} from '../providers/bedrock-model-id';

/**
 * BST-1738: Bedrock routing comes from each model's own AWS card (retrieved
 * 2026-10-18). A region gets a geo prefix exactly when the card lists it as a
 * source region of that geo profile; otherwise `global.` where the card marks
 * it Global ✓; otherwise the id is sent verbatim. GovCloud is always verbatim.
 */
describe('resolveBedrockModelId', () => {
  describe('passes an already-prefixed id through untouched', () => {
    it.each([
      'global.anthropic.claude-opus-4-5-20251101-v1:0',
      'us.anthropic.claude-sonnet-5',
      'eu.anthropic.claude-opus-4-8',
      'jp.anthropic.claude-sonnet-4-6',
      'in.anthropic.claude-opus-5',
      'apac.amazon.nova-pro-v1:0',
      'ca.amazon.nova-lite-v1:0',
      'us-gov.anthropic.claude-opus-4-8',
      'au.anthropic.claude-haiku-4-5-20251001-v1:0',
    ])('%s', (id) => {
      for (const region of ['us-east-1', 'eu-west-1', 'ap-southeast-2', 'ap-south-1']) {
        expect(resolveBedrockModelId(id, region)).toBe(id);
      }
      expect(stripCrossRegionPrefix(id)).toBe(id.slice(id.indexOf('.') + 1));
    });
  });

  describe('the under-emissions the prefix-shaped region map left (card Geo ✓, In-Region ✗)', () => {
    it.each([
      // Canada is a source of the US geo on every Claude card that lists it.
      ['anthropic.claude-sonnet-5', 'ca-central-1', 'us.anthropic.claude-sonnet-5'],
      ['anthropic.claude-sonnet-5', 'ca-west-1', 'us.anthropic.claude-sonnet-5'],
      ['anthropic.claude-fable-5-1', 'ca-central-1', 'us.anthropic.claude-fable-5-1'],
      // Zurich is a source of the EU geo.
      ['anthropic.claude-opus-5-5', 'eu-central-2', 'eu.anthropic.claude-opus-5-5'],
      ['anthropic.claude-sonnet-4-6', 'eu-central-2', 'eu.anthropic.claude-sonnet-4-6'],
      // Osaka is a source of the JP geo.
      ['anthropic.claude-opus-4-8', 'ap-northeast-3', 'jp.anthropic.claude-opus-4-8'],
      [
        'anthropic.claude-haiku-4-5-20251001-v1:0',
        'ap-northeast-3',
        'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
      ],
      // New Zealand is a source of the AU geo where the card says so.
      ['anthropic.claude-sonnet-4-6', 'ap-southeast-6', 'au.anthropic.claude-sonnet-4-6'],
      [
        'anthropic.claude-haiku-4-5-20251001-v1:0',
        'ap-southeast-6',
        'au.anthropic.claude-haiku-4-5-20251001-v1:0',
      ],
      // The India geo the Opus 5, Sonnet 5 and Haiku 4.5 cards now publish.
      ['anthropic.claude-opus-5', 'ap-south-1', 'in.anthropic.claude-opus-5'],
      ['anthropic.claude-sonnet-5', 'ap-south-2', 'in.anthropic.claude-sonnet-5'],
      [
        'anthropic.claude-haiku-4-5-20251001-v1:0',
        'ap-south-1',
        'in.anthropic.claude-haiku-4-5-20251001-v1:0',
      ],
      // Nova's geo profiles (In-Region ✗ in these regions).
      ['amazon.nova-pro-v1:0', 'us-east-2', 'us.amazon.nova-pro-v1:0'],
      ['amazon.nova-pro-v1:0', 'ap-northeast-1', 'apac.amazon.nova-pro-v1:0'],
      ['amazon.nova-lite-v1:0', 'ca-central-1', 'ca.amazon.nova-lite-v1:0'],
      ['amazon.nova-2-lite-v1:0', 'ap-northeast-1', 'jp.amazon.nova-2-lite-v1:0'],
      ['amazon.nova-2-lite-v1:0', 'ap-southeast-2', 'global.amazon.nova-2-lite-v1:0'],
    ])('%s in %s → %s', (id, region, expected) => {
      expect(resolveBedrockModelId(id, region)).toBe(expected);
    });
  });

  describe('no phantom profile', () => {
    it('never emits eu. for Fable 5, whose card publishes us. and global. only', () => {
      for (const region of ['eu-west-1', 'eu-central-1', 'eu-central-2', 'eu-west-2']) {
        expect(resolveBedrockModelId('anthropic.claude-fable-5', region)).toBe(
          'global.anthropic.claude-fable-5'
        );
      }
    });

    it('never emits jp. for the cards with no JP geo, routing Tokyo through global.', () => {
      for (const id of [
        'anthropic.claude-opus-5',
        'anthropic.claude-sonnet-5',
        'anthropic.claude-sonnet-5-5',
        'anthropic.claude-fable-5',
        'anthropic.claude-opus-4-6-v1',
        'anthropic.claude-opus-4-5-20251101-v1:0',
      ]) {
        expect(resolveBedrockModelId(id, 'ap-northeast-1')).toBe(`global.${id}`);
      }
    });

    it('emits only the geo prefixes each card publishes in its Programmatic Access row', () => {
      const prefixes = Object.fromEntries(
        [...BEDROCK_INFERENCE_ROUTES].map(([id, routes]) => [
          id,
          [...new Set(routes.geo.values())].sort(),
        ])
      );
      expect(prefixes).toEqual({
        'amazon.nova-2-lite-v1:0': ['eu', 'jp', 'us'],
        'amazon.nova-lite-v1:0': ['apac', 'ca', 'eu', 'us'],
        'amazon.nova-micro-v1:0': ['eu', 'us'],
        'amazon.nova-pro-v1:0': ['apac', 'eu', 'us'],
        'anthropic.claude-fable-5': ['us'],
        'anthropic.claude-fable-5-1': ['us'],
        'anthropic.claude-fable-5-2': ['us'],
        'anthropic.claude-haiku-4-5-20251001-v1:0': ['au', 'eu', 'in', 'jp', 'us'],
        'anthropic.claude-haiku-5-5': ['au', 'eu', 'jp', 'us'],
        'anthropic.claude-opus-4-1-20250805-v1:0': ['us'],
        'anthropic.claude-opus-4-5-20251101-v1:0': ['eu', 'us'],
        'anthropic.claude-opus-4-6-v1': ['au', 'eu', 'us'],
        'anthropic.claude-opus-4-7': ['au', 'eu', 'jp', 'us'],
        'anthropic.claude-opus-4-8': ['au', 'eu', 'jp', 'us'],
        'anthropic.claude-opus-5': ['au', 'eu', 'in', 'us'],
        'anthropic.claude-opus-5-5': ['au', 'eu', 'jp', 'us'],
        'anthropic.claude-sonnet-4-5-20250929-v1:0': ['au', 'eu', 'jp', 'us'],
        'anthropic.claude-sonnet-4-6': ['au', 'eu', 'jp', 'us'],
        'anthropic.claude-sonnet-5': ['au', 'eu', 'in', 'us'],
        'anthropic.claude-sonnet-5-5': ['au', 'eu', 'us'],
        'deepseek.r1-v1:0': ['us'],
        'deepseek.v3.2': [],
        'meta.llama4-maverick-17b-instruct-v1:0': ['us'],
        'meta.llama4-scout-17b-instruct-v1:0': ['us'],
      });
    });
  });

  describe('precedence', () => {
    it('prefers the geo profile over global. wherever the region is a geo source', () => {
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'eu-west-1')).toBe(
        'eu.anthropic.claude-sonnet-5'
      );
      // Opus 5.5 is also In-Region ✓ in London; geo still wins (residency first).
      expect(resolveBedrockModelId('anthropic.claude-opus-5-5', 'eu-west-2')).toBe(
        'eu.anthropic.claude-opus-5-5'
      );
    });

    it('routes a Geo ✗ / Global ✓ region through global.', () => {
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'sa-east-1')).toBe(
        'global.anthropic.claude-sonnet-5'
      );
      expect(resolveBedrockModelId('anthropic.claude-opus-5-5', 'ap-southeast-6')).toBe(
        'global.anthropic.claude-opus-5-5'
      );
    });

    it('sends the id verbatim where the card offers neither', () => {
      // DeepSeek V3.2 has no cross-region profile; Llama 4 has no global one.
      expect(resolveBedrockModelId('deepseek.v3.2', 'us-east-1')).toBe('deepseek.v3.2');
      expect(resolveBedrockModelId('meta.llama4-scout-17b-instruct-v1:0', 'eu-west-1')).toBe(
        'meta.llama4-scout-17b-instruct-v1:0'
      );
      // Hong Kong appears on no card's availability table.
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'ap-east-1')).toBe(
        'anthropic.claude-sonnet-5'
      );
    });

    it('sends an uncatalogued id verbatim', () => {
      expect(resolveBedrockModelId('anthropic.claude-not-in-catalog', 'us-east-1')).toBe(
        'anthropic.claude-not-in-catalog'
      );
    });

    it('keeps GovCloud verbatim, never us. and never global.', () => {
      for (const region of ['us-gov-west-1', 'us-gov-east-1']) {
        for (const id of BEDROCK_INFERENCE_ROUTES.keys()) {
          expect(resolveBedrockModelId(id, region)).toBe(id);
        }
      }
    });
  });

  describe('table invariants', () => {
    it('has a row for every Bedrock catalog id', () => {
      const missing = listProviderLlmModels('bedrock')
        .map((model) => model.id)
        .filter((id) => !BEDROCK_INFERENCE_ROUTES.has(id));
      expect(missing).toEqual([]);
    });

    it('never lists a region as both a geo source and global-only', () => {
      const overlaps = [...BEDROCK_INFERENCE_ROUTES].flatMap(([id, routes]) =>
        [...routes.global]
          .filter((region) => routes.geo.has(region))
          .map((region) => `${id}@${region}`)
      );
      expect(overlaps).toEqual([]);
    });

    it('carries no GovCloud region, which this module leaves verbatim', () => {
      const govRows = [...BEDROCK_INFERENCE_ROUTES].flatMap(([id, routes]) =>
        [...routes.geo.keys(), ...routes.global]
          .filter((region) => region.startsWith('us-gov-'))
          .map((region) => `${id}@${region}`)
      );
      expect(govRows).toEqual([]);
    });

    it('resolves every row to its own prefix and strips back to the catalog id', () => {
      for (const [id, routes] of BEDROCK_INFERENCE_ROUTES) {
        for (const [region, prefix] of routes.geo) {
          const routed = resolveBedrockModelId(id, region);
          expect(routed).toBe(`${prefix}.${id}`);
          expect(stripCrossRegionPrefix(routed)).toBe(id);
        }
        for (const region of routes.global) {
          expect(resolveBedrockModelId(id, region)).toBe(`global.${id}`);
        }
      }
    });
  });
});
