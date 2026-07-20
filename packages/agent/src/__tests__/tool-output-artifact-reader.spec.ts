import {
  decodeToolOutputArtifactContent,
  decodeToolOutputArtifactCursor,
  encodeToolOutputArtifactCursor,
  type ToolOutputArtifactReference,
} from '@brainstrike/assistant-contract/tool-output-artifact';
import { describe, expect, it, vi } from 'vitest';
import {
  projectToolOutputArtifactPage,
  ReadToolOutputArtifactInputSchema,
  readToolOutputArtifactPage,
  type ScopedToolOutputArtifactReader,
} from '../mastra/tool-output-artifact-reader';
import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '../stream/tool-output-limits';

const TEXT_ENCODER = new TextEncoder();
const NOW = new Date('2026-07-20T12:00:00.000Z');

function referenceFor(
  content: string,
  overrides: Partial<ToolOutputArtifactReference> = {}
): ToolOutputArtifactReference {
  return {
    byteLength: TEXT_ENCODER.encode(content).byteLength,
    expiresAt: '2026-07-27T12:00:00.000Z',
    format: 'text',
    id: '019f7d67-7165-7c23-8e99-d70c2a2f168d',
    ...overrides,
  };
}

function readerFor(
  content: string,
  artifactRef = referenceFor(content)
): ScopedToolOutputArtifactReader {
  const bytes = TEXT_ENCODER.encode(content);
  return {
    readRange: async ({ artifactId, limitBytes, offsetByte }) => {
      if (artifactId !== artifactRef.id) {
        return { status: 'not_found' };
      }
      const page = bytes.slice(offsetByte, offsetByte + limitBytes);
      return {
        bytes: page,
        endByte: offsetByte + page.byteLength,
        offsetByte,
        reference: artifactRef,
        status: 'found',
      };
    },
  };
}

describe('tool output artifact reader', () => {
  it('uses a strict discriminant for initial references and continuation cursors', () => {
    const artifactRef = referenceFor('content');
    const cursor = encodeToolOutputArtifactCursor(artifactRef, 1);

    expect(
      ReadToolOutputArtifactInputSchema.safeParse({
        artifactRef,
        maxBytes: 4,
        mode: 'artifact',
      }).success
    ).toBe(true);
    expect(
      ReadToolOutputArtifactInputSchema.safeParse({
        cursor,
        maxBytes: 4,
        mode: 'cursor',
      }).success
    ).toBe(true);
    expect(
      ReadToolOutputArtifactInputSchema.safeParse({
        artifactRef,
        cursor,
        mode: 'artifact',
      }).success
    ).toBe(false);
    expect(
      ReadToolOutputArtifactInputSchema.safeParse({
        cursor,
        mode: 'artifact',
      }).success
    ).toBe(false);
  });

  it('concatenates multi-page UTF-8, CRLF, emoji, and U+0000 content byte-exactly', async () => {
    const content = 'A🙂\r\nB\u0000C🙂tail';
    const artifactRef = referenceFor(content);
    const reader = readerFor(content, artifactRef);
    const pages = [];
    let input: unknown = {
      artifactRef,
      maxBytes: 4,
      mode: 'artifact',
    };

    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await readToolOutputArtifactPage(input, { now: () => NOW, reader });
      pages.push(page);
      if (!page.nextCursor) {
        break;
      }
      expect(decodeToolOutputArtifactCursor(page.nextCursor)).toEqual({
        artifactRef,
        offsetByte: page.endByte,
      });
      input = {
        cursor: page.nextCursor,
        maxBytes: 4,
        mode: 'cursor',
      };
    }

    expect(pages.at(-1)?.nextCursor).toBeUndefined();
    expect(pages.map((page) => page.offsetByte)).toEqual(
      pages.map((_page, index) => (index === 0 ? 0 : pages[index - 1]?.endByte))
    );
    const recovered = pages
      .map((page) => decodeToolOutputArtifactContent(page.content, page.contentEncoding))
      .join('');
    expect(TEXT_ENCODER.encode(recovered)).toEqual(TEXT_ENCODER.encode(content));
    expect(pages.some((page) => page.contentEncoding === 'json-string')).toBe(true);
  });

  it('preserves a UTF-8 BOM as artifact content', async () => {
    const content = '\uFEFFabc';
    const artifactRef = referenceFor(content);
    const page = await readToolOutputArtifactPage(
      { artifactRef, maxBytes: 4, mode: 'artifact' },
      { now: () => NOW, reader: readerFor(content, artifactRef) }
    );

    expect(decodeToolOutputArtifactContent(page.content, page.contentEncoding)).toBe('\uFEFFa');
    expect(page.endByte).toBe(4);
  });

  it('requests no bytes beyond the configured page size', async () => {
    const content = 'abcdefgh';
    const artifactRef = referenceFor(content);
    const reader = readerFor(content, artifactRef);
    const readRange = vi.spyOn(reader, 'readRange');

    await readToolOutputArtifactPage(
      { artifactRef, maxBytes: 4, mode: 'artifact' },
      { now: () => NOW, reader }
    );

    expect(readRange).toHaveBeenCalledWith({
      artifactId: artifactRef.id,
      limitBytes: 4,
      offsetByte: 0,
    });
  });

  it('continues from a settlement cursor and omits a cursor at the exact boundary', async () => {
    const content = 'preview-tail';
    const artifactRef = referenceFor(content);
    const offsetByte = TEXT_ENCODER.encode('preview-').byteLength;
    const page = await readToolOutputArtifactPage(
      {
        cursor: encodeToolOutputArtifactCursor(artifactRef, offsetByte),
        maxBytes: 8,
        mode: 'cursor',
      },
      { now: () => NOW, reader: readerFor(content, artifactRef) }
    );

    expect(page).toMatchObject({
      artifactRef,
      content: 'tail',
      endByte: artifactRef.byteLength,
      offsetByte,
    });
    expect(page.nextCursor).toBeUndefined();
  });

  it('returns one valid terminal page for an empty artifact', async () => {
    const artifactRef = referenceFor('');
    const page = await readToolOutputArtifactPage(
      { artifactRef, mode: 'artifact' },
      { now: () => NOW, reader: readerFor('', artifactRef) }
    );

    expect(page).toEqual({
      artifactRef,
      content: '',
      endByte: 0,
      offsetByte: 0,
    });
  });

  it('surfaces malformed cursors and invalid inputs as typed failures', async () => {
    const reader = readerFor('content');

    await expect(
      readToolOutputArtifactPage(
        { cursor: 'bsto1.not-a-cursor', mode: 'cursor' },
        { now: () => NOW, reader }
      )
    ).rejects.toMatchObject({ reason: 'malformed_cursor' });
    await expect(
      readToolOutputArtifactPage(
        { artifactRef: referenceFor('content'), cursor: 'extra', mode: 'artifact' },
        { now: () => NOW, reader }
      )
    ).rejects.toMatchObject({ reason: 'invalid_input' });
    await expect(
      readToolOutputArtifactPage(
        {
          cursor: encodeToolOutputArtifactCursor(referenceFor('content'), 1),
          maxBytes: 1,
          mode: 'cursor',
        },
        { now: () => NOW, reader }
      )
    ).rejects.toMatchObject({ reason: 'invalid_input' });
  });

  it('fails expired, wrong-scope, incoherent, non-progress, and storage reads visibly', async () => {
    const artifactRef = referenceFor('content');
    const input = { artifactRef, mode: 'artifact' } as const;

    await expect(
      readToolOutputArtifactPage(input, {
        now: () => NOW,
        reader: { readRange: async () => ({ reference: artifactRef, status: 'expired' }) },
      })
    ).rejects.toMatchObject({ reason: 'artifact_expired' });

    await expect(
      readToolOutputArtifactPage(input, {
        now: () => NOW,
        reader: { readRange: async () => ({ status: 'not_found' }) },
      })
    ).rejects.toMatchObject({ reason: 'artifact_not_found' });

    await expect(
      readToolOutputArtifactPage(input, {
        now: () => NOW,
        reader: readerFor('content', { ...artifactRef, format: 'json' }),
      })
    ).rejects.toMatchObject({ reason: 'artifact_incoherent' });

    await expect(
      readToolOutputArtifactPage(input, {
        now: () => NOW,
        reader: {
          readRange: async () => ({
            bytes: new Uint8Array(),
            endByte: 0,
            offsetByte: 0,
            reference: artifactRef,
            status: 'found',
          }),
        },
      })
    ).rejects.toMatchObject({ reason: 'non_progress' });

    const storageError = new Error('database unavailable');
    await expect(
      readToolOutputArtifactPage(input, {
        now: () => NOW,
        reader: {
          readRange: vi.fn(async () => {
            throw storageError;
          }),
        },
      })
    ).rejects.toMatchObject({ cause: storageError, reason: 'storage_failed' });
  });

  it('rejects malformed UTF-8 and incoherent byte ranges from storage', async () => {
    const artifactRef = referenceFor('abcd');
    const invalidUtf8 = Uint8Array.from([0xf0, 0x28, 0x8c, 0x28]);

    await expect(
      readToolOutputArtifactPage(
        { artifactRef, maxBytes: 4, mode: 'artifact' },
        {
          now: () => NOW,
          reader: {
            readRange: async () => ({
              bytes: invalidUtf8,
              endByte: invalidUtf8.byteLength,
              offsetByte: 0,
              reference: artifactRef,
              status: 'found',
            }),
          },
        }
      )
    ).rejects.toMatchObject({ reason: 'artifact_incoherent' });
  });

  it('projects an escape-heavy raw page within budget using an exact shorter cursor', async () => {
    const content = `head${'\u0000'.repeat(2000)}tail`;
    const artifactRef = referenceFor(content);
    const rawPage = await readToolOutputArtifactPage(
      { artifactRef, maxBytes: 8000, mode: 'artifact' },
      { now: () => NOW, reader: readerFor(content, artifactRef) }
    );

    const projection = projectToolOutputArtifactPage(rawPage);
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projection.value.next?.tool).toBe('brainstrike.readToolOutputArtifact');
    const projectedContent = decodeToolOutputArtifactContent(
      projection.value.content,
      projection.value.contentEncoding
    );
    expect(content.startsWith(projectedContent)).toBe(true);
    expect(decodeToolOutputArtifactCursor(projection.value.next?.input.cursor ?? '')).toEqual({
      artifactRef,
      offsetByte: TEXT_ENCODER.encode(projectedContent).byteLength,
    });
    expect(projection.value.endByte).toBe(TEXT_ENCODER.encode(projectedContent).byteLength);
  });

  it('keeps a fitting terminal page whole even when a shorter cursor-bearing page does not fit', () => {
    const content = 'x'.repeat(5800);
    const artifactRef = referenceFor(content);
    const rawPage = {
      artifactRef,
      content,
      endByte: artifactRef.byteLength,
      offsetByte: 0,
    };

    const projection = projectToolOutputArtifactPage(rawPage);

    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projection.value).toMatchObject({
      complete: true,
      content,
      endByte: artifactRef.byteLength,
      offsetByte: 0,
    });
    expect(projection.value.next).toBeUndefined();
  });
});
