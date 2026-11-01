import type { TokenMeasurementCapability } from '@brainstrike/assistant-contract/provider-registry';
import { describe, expect, it } from 'vitest';
import { TokenCounterUnavailableError } from '../token-counter';
import {
  createPreparedTokenMeasurement,
  serializeModelOutputForTokenMeasurement,
} from '../token-measurement';
import { TOKEN_MEASUREMENT_FIXTURES } from './fixtures/token-measurement-fixtures';

const EXACT_O200K: TokenMeasurementCapability = {
  mode: 'exact-selected-model',
  tokenizer: 'o200k_base',
};

describe('prepared token measurement', () => {
  it.each(TOKEN_MEASUREMENT_FIXTURES)(
    'matches the verified o200k count for $name',
    async ({ o200kTokens, text }) => {
      const measurement = await createPreparedTokenMeasurement(EXACT_O200K);

      expect(await measurement.measure(text)).toEqual({
        backstopTokens: Math.ceil(text.length / 4),
        serializedCharacters: text.length,
        status: 'measured',
        tokenCount: o200kTokens,
      });
    }
  );

  it('labels a deterministic backstop without claiming exactness', async () => {
    const measurement = await createPreparedTokenMeasurement({
      charactersPerToken: 4,
      mode: 'deterministic-serialized-character-backstop',
    });

    expect(measurement.capability.mode).toBe('deterministic-serialized-character-backstop');
    expect(await measurement.measure('工具🧠')).toEqual({
      backstopTokens: 1,
      serializedCharacters: 4,
      status: 'measured',
      tokenCount: 1,
    });
  });

  it('surfaces counter initialization failure under the declared mode', async () => {
    const measurement = await createPreparedTokenMeasurement(EXACT_O200K, {
      loadCounter: async () => {
        throw new Error('fixture initialization failed');
      },
    });

    expect(await measurement.measure('bounded input')).toEqual({
      backstopTokens: 4,
      failureCode: 'counter-initialization-failed',
      failureMessage: 'fixture initialization failed',
      serializedCharacters: 13,
      status: 'failed',
    });
    expect(measurement.capability).toEqual(EXACT_O200K);
  });

  it('surfaces counter execution failure instead of changing modes', async () => {
    const measurement = await createPreparedTokenMeasurement(EXACT_O200K, {
      loadCounter: async () => async () => {
        throw new Error('fixture encode failed');
      },
    });

    expect(await measurement.measure('bounded input')).toMatchObject({
      failureCode: 'counter-execution-failed',
      failureMessage: 'fixture encode failed',
      status: 'failed',
    });
    expect(measurement.capability).toEqual(EXACT_O200K);
  });

  it('reads a counter whose worker failed as an initialization failure, not a mode change', async () => {
    const measurement = await createPreparedTokenMeasurement(EXACT_O200K, {
      loadCounter: async () => async () => {
        throw new TokenCounterUnavailableError('The token counter exited (code 1)');
      },
    });

    expect(await measurement.measure('bounded input')).toMatchObject({
      failureCode: 'counter-initialization-failed',
      failureMessage: 'The token counter exited (code 1)',
      status: 'failed',
    });
  });
});

describe('token measurement serialization', () => {
  it('compacts inline media to a deterministic marker before counting', () => {
    const serialized = serializeModelOutputForTokenMeasurement({
      type: 'content',
      value: [
        { text: 'Summary', type: 'text' },
        { data: 'secret-base64-payload', mediaType: 'image/png', type: 'image-data' },
      ],
    });

    expect(serialized).toContain(
      '[image-data payload omitted from token count; media type: image/png]'
    );
    expect(serialized).not.toContain('secret-base64-payload');
  });

  it('compacts SDK7 inline file bytes while retaining inline text, URLs and references', () => {
    const output = [
      { data: { data: 'inline-image-bytes', type: 'data' }, mediaType: 'image/png', type: 'file' },
      {
        data: { type: 'url', url: new URL('data:image/png;base64,inline-data-url') },
        mediaType: 'image/png',
        type: 'file',
      },
      {
        data: { text: 'important inline document', type: 'text' },
        mediaType: 'text/plain',
        type: 'file',
      },
      {
        data: { type: 'url', url: new URL('https://example.test/image.png') },
        mediaType: 'image/png',
        type: 'file',
      },
      {
        data: { reference: { openai: 'file_reference' }, type: 'reference' },
        mediaType: 'image/png',
        type: 'file',
      },
    ];
    const serialized = serializeModelOutputForTokenMeasurement(output);
    expect(serialized).not.toContain('inline-image-bytes');
    expect(serialized).not.toContain('inline-data-url');
    expect(serialized).toContain('important inline document');
    expect(serialized).toContain('https://example.test/image.png');
    expect(serialized).toContain('file_reference');
    expect(output[0]?.data).toEqual({ data: 'inline-image-bytes', type: 'data' });
  });
});
