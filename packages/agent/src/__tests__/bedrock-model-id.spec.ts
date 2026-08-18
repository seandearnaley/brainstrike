import { describe, expect, it } from 'vitest';
import { resolveBedrockModelId } from '../providers/bedrock-model-id';

/**
 * BST-1350: cross-region inference-profile prefixing, ported from opencode's
 * `resolveModelID` (packages/core/src/plugin/provider/amazon-bedrock.ts) and
 * its test expectations. The table is deliberately NARROW — models/regions
 * outside it pass through unprefixed, and an already-prefixed id is NEVER
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
    const prefixRequired = [
      'amazon.nova-micro-v1:0',
      'amazon.nova-lite-v1:0',
      'amazon.nova-pro-v1:0',
      'amazon.nova-premier-v1:0',
      'anthropic.claude-sonnet-5',
      'anthropic.claude-fable-5',
      'deepseek.v3.2',
    ];
    it('prefixes the nova/claude/deepseek families with us.', () => {
      expect(resolveBedrockModelId('amazon.nova-micro-v1:0', 'us-east-1')).toBe(
        'us.amazon.nova-micro-v1:0'
      );
      expect(resolveBedrockModelId('amazon.nova-lite-v1:0', 'us-west-2')).toBe(
        'us.amazon.nova-lite-v1:0'
      );
      expect(resolveBedrockModelId('amazon.nova-pro-v1:0', 'us-east-2')).toBe(
        'us.amazon.nova-pro-v1:0'
      );
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'us-east-1')).toBe(
        'us.anthropic.claude-sonnet-5'
      );
      expect(resolveBedrockModelId('deepseek.v3.2', 'us-east-1')).toBe('us.deepseek.v3.2');
    });

    it('prefixes nova-premier and nova-2 substrings', () => {
      expect(resolveBedrockModelId('amazon.nova-premier-v1:0', 'us-east-1')).toBe(
        'us.amazon.nova-premier-v1:0'
      );
      expect(resolveBedrockModelId('amazon.nova-2-lite-v1:0', 'us-east-1')).toBe(
        'us.amazon.nova-2-lite-v1:0'
      );
    });

    it('leaves models outside the table unprefixed', () => {
      expect(resolveBedrockModelId('meta.llama4-maverick-17b-instruct-v1:0', 'us-east-1')).toBe(
        'meta.llama4-maverick-17b-instruct-v1:0'
      );
      expect(resolveBedrockModelId('cohere.command-r-plus-v1:0', 'us-east-1')).toBe(
        'cohere.command-r-plus-v1:0'
      );
    });

    it('excludes us-gov regions from the us. prefix', () => {
      for (const id of prefixRequired) {
        expect(resolveBedrockModelId(id, 'us-gov-west-1')).toBe(id);
        expect(resolveBedrockModelId(id, 'us-gov-east-1')).toBe(id);
      }
    });
  });

  describe('eu regions', () => {
    it('prefixes claude/nova-lite/nova-micro/llama3/pixtral in listed eu regions', () => {
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
      expect(resolveBedrockModelId('amazon.nova-lite-v1:0', 'eu-west-1')).toBe(
        'eu.amazon.nova-lite-v1:0'
      );
      expect(resolveBedrockModelId('amazon.nova-micro-v1:0', 'eu-central-1')).toBe(
        'eu.amazon.nova-micro-v1:0'
      );
      expect(resolveBedrockModelId('meta.llama3-1-70b-instruct-v1:0', 'eu-west-2')).toBe(
        'eu.meta.llama3-1-70b-instruct-v1:0'
      );
      expect(resolveBedrockModelId('mistral.pixtral-large-2502-v1:0', 'eu-north-1')).toBe(
        'eu.mistral.pixtral-large-2502-v1:0'
      );
    });

    it('leaves other models and unlisted eu regions unprefixed', () => {
      // nova-pro is NOT in the eu table (unlike the us/apac tables).
      expect(resolveBedrockModelId('amazon.nova-pro-v1:0', 'eu-west-1')).toBe(
        'amazon.nova-pro-v1:0'
      );
      // eu-central-2 is not in the listed eu region set.
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'eu-central-2')).toBe(
        'anthropic.claude-sonnet-5'
      );
      // llama4 does not match the llama3 substring.
      expect(resolveBedrockModelId('meta.llama4-scout-17b-instruct-v1:0', 'eu-west-1')).toBe(
        'meta.llama4-scout-17b-instruct-v1:0'
      );
    });
  });

  describe('ap regions', () => {
    it('routes ap-southeast-2/4 claude-sonnet-4-5 and claude-haiku to au.', () => {
      expect(
        resolveBedrockModelId('anthropic.claude-sonnet-4-5-20250929-v1:0', 'ap-southeast-2')
      ).toBe('au.anthropic.claude-sonnet-4-5-20250929-v1:0');
      expect(
        resolveBedrockModelId('anthropic.claude-haiku-4-5-20251001-v1:0', 'ap-southeast-4')
      ).toBe('au.anthropic.claude-haiku-4-5-20251001-v1:0');
    });

    it('routes other au-region claude models through the apac table (opencode parity)', () => {
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'ap-southeast-2')).toBe(
        'apac.anthropic.claude-sonnet-5'
      );
    });

    it('uses jp. for ap-northeast-1 and apac. elsewhere', () => {
      expect(resolveBedrockModelId('anthropic.claude-sonnet-5', 'ap-northeast-1')).toBe(
        'jp.anthropic.claude-sonnet-5'
      );
      expect(resolveBedrockModelId('amazon.nova-pro-v1:0', 'ap-south-1')).toBe(
        'apac.amazon.nova-pro-v1:0'
      );
      expect(resolveBedrockModelId('amazon.nova-lite-v1:0', 'ap-southeast-1')).toBe(
        'apac.amazon.nova-lite-v1:0'
      );
      expect(resolveBedrockModelId('amazon.nova-micro-v1:0', 'ap-northeast-2')).toBe(
        'apac.amazon.nova-micro-v1:0'
      );
    });

    it('leaves models outside the apac table unprefixed', () => {
      expect(resolveBedrockModelId('deepseek.v3.2', 'ap-south-1')).toBe('deepseek.v3.2');
      expect(
        resolveBedrockModelId('meta.llama4-maverick-17b-instruct-v1:0', 'ap-northeast-1')
      ).toBe('meta.llama4-maverick-17b-instruct-v1:0');
    });
  });

  describe('other regions', () => {
    it('never prefixes outside us/eu/ap', () => {
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
