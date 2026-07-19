import { describe, expect, it, vi } from 'vitest';
import {
  decodeToolOutputArtifactContent,
  encodeToolOutputArtifactContent,
  isToolOutputArtifactCursor,
  isToolOutputArtifactEnvelope,
  isToolOutputArtifactPage,
  isToolOutputArtifactReference,
  TOOL_OUTPUT_ARTIFACT_CODE,
  TOOL_OUTPUT_ARTIFACT_DEFAULT_PAGE_BYTES,
  TOOL_OUTPUT_ARTIFACT_JSON_STRING_ENCODING,
  TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
  TOOL_OUTPUT_ARTIFACT_MIN_PAGE_BYTES,
  TOOL_OUTPUT_ARTIFACT_VERSION,
} from '../tool-output-artifact';

const reference = {
  byteLength: 9,
  expiresAt: '2026-07-25T12:00:00.000Z',
  format: 'text',
  id: '019f7358-6492-7fc1-984b-f07b481cda91',
} as const;

const cursor = 'bsto1.eyJhcnRpZmFjdCI6Im9wYXF1ZSJ9';

describe('tool output artifact contracts', () => {
  it('accepts one canonical opaque reference and recoverable preview envelope', () => {
    expect(isToolOutputArtifactReference(reference)).toBe(true);
    expect(
      isToolOutputArtifactEnvelope({
        artifactRef: reference,
        code: TOOL_OUTPUT_ARTIFACT_CODE,
        hint: 'Continue with the artifact reader.',
        nextCursor: cursor,
        preview: 'HEAD',
        truncated: true,
        version: TOOL_OUTPUT_ARTIFACT_VERSION,
      })
    ).toBe(true);
  });

  it('rejects path-like ids, malformed cursors, extra fields, and false truncation claims', () => {
    expect(isToolOutputArtifactReference({ ...reference, id: '/tmp/output.json' })).toBe(false);
    expect(isToolOutputArtifactReference({ ...reference, byteLength: -1 })).toBe(false);
    expect(isToolOutputArtifactReference({ ...reference, format: 'binary' })).toBe(false);
    expect(isToolOutputArtifactReference({ ...reference, owner: 'thread-id' })).toBe(false);
    expect(isToolOutputArtifactCursor('bsto1.')).toBe(false);
    expect(isToolOutputArtifactCursor('legacy:cursor')).toBe(false);
    expect(
      isToolOutputArtifactEnvelope({
        artifactRef: reference,
        code: TOOL_OUTPUT_ARTIFACT_CODE,
        hint: 'Continue.',
        preview: 'HEAD',
        truncated: true,
        version: TOOL_OUTPUT_ARTIFACT_VERSION,
      })
    ).toBe(false);
    expect(
      isToolOutputArtifactEnvelope({
        artifactRef: reference,
        code: TOOL_OUTPUT_ARTIFACT_CODE,
        hint: 'Continue.',
        nextCursor: cursor,
        preview: 'HEAD-tail',
        truncated: true,
        version: TOOL_OUTPUT_ARTIFACT_VERSION,
      })
    ).toBe(false);
  });

  it('rejects required artifact fields inherited from a prototype', () => {
    const inheritedReference: unknown = Object.create(reference);
    const inheritedEnvelope: unknown = Object.create({
      artifactRef: reference,
      code: TOOL_OUTPUT_ARTIFACT_CODE,
      hint: 'Continue.',
      nextCursor: cursor,
      preview: 'HEAD',
      truncated: true,
      version: TOOL_OUTPUT_ARTIFACT_VERSION,
    });
    const inheritedPage: unknown = Object.create({
      artifactRef: reference,
      content: 'tail',
      endByte: 9,
      offsetByte: 5,
    });

    expect(isToolOutputArtifactReference(inheritedReference)).toBe(false);
    expect(isToolOutputArtifactEnvelope(inheritedEnvelope)).toBe(false);
    expect(isToolOutputArtifactPage(inheritedPage)).toBe(false);
  });

  it('uses explicit reversible encoding for PostgreSQL JSON-unsafe content', () => {
    const raw = '\u0000🙂"\\\n';
    const encoded = encodeToolOutputArtifactContent(raw);

    expect(encoded).toEqual({
      content: JSON.stringify(raw),
      contentEncoding: TOOL_OUTPUT_ARTIFACT_JSON_STRING_ENCODING,
    });
    expect(decodeToolOutputArtifactContent(encoded.content, encoded.contentEncoding)).toBe(raw);
    expect(encoded.content).not.toContain('\u0000');
    expect(() => decodeToolOutputArtifactContent(raw)).toThrow(/U\+0000/u);
    expect(() => decodeToolOutputArtifactContent('"text"', 'base64' as never)).toThrow(
      /Unsupported/u
    );
    expect(() =>
      decodeToolOutputArtifactContent('{', TOOL_OUTPUT_ARTIFACT_JSON_STRING_ENCODING)
    ).toThrow(/malformed/u);
  });

  it('validates continuation pages by decoded UTF-8 byte span', () => {
    expect(
      isToolOutputArtifactPage({
        artifactRef: reference,
        content: 'A🙂',
        endByte: 5,
        nextCursor: cursor,
        offsetByte: 0,
      })
    ).toBe(true);
    expect(
      isToolOutputArtifactPage({
        artifactRef: reference,
        content: 'tail',
        endByte: 9,
        offsetByte: 5,
      })
    ).toBe(true);
  });

  it('rejects gaps, overlaps, and incoherent continuation cursors', () => {
    const firstPage = {
      artifactRef: reference,
      content: 'A🙂',
      endByte: 5,
      nextCursor: cursor,
      offsetByte: 0,
    };

    expect(isToolOutputArtifactPage({ ...firstPage, endByte: 3 })).toBe(false);
    expect(isToolOutputArtifactPage({ ...firstPage, nextCursor: undefined })).toBe(false);
    expect(
      isToolOutputArtifactPage({
        artifactRef: reference,
        content: 'tail',
        endByte: 9,
        nextCursor: cursor,
        offsetByte: 5,
      })
    ).toBe(false);
    expect(isToolOutputArtifactPage({ ...firstPage, debugPath: '/tmp/output' })).toBe(false);
  });

  it('measures encoded page content after decoding and publishes bounded defaults', () => {
    const encoded = encodeToolOutputArtifactContent('\u0000🙂');
    const encodedReference = { ...reference, byteLength: 5 };

    expect(
      isToolOutputArtifactPage({
        artifactRef: encodedReference,
        content: encoded.content,
        contentEncoding: encoded.contentEncoding,
        endByte: 5,
        offsetByte: 0,
      })
    ).toBe(true);
    expect(TOOL_OUTPUT_ARTIFACT_MIN_PAGE_BYTES).toBe(4);
    expect(TOOL_OUTPUT_ARTIFACT_DEFAULT_PAGE_BYTES).toBe(6000);
    expect(TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES).toBe(8000);
  });

  it('rejects oversized raw content before encoding or parsing it', () => {
    const encodeSpy = vi.spyOn(TextEncoder.prototype, 'encode');
    const parseSpy = vi.spyOn(JSON, 'parse');
    const largeReference = { ...reference, byteLength: 100_000 };

    expect(
      isToolOutputArtifactEnvelope({
        artifactRef: largeReference,
        code: TOOL_OUTPUT_ARTIFACT_CODE,
        hint: 'Continue.',
        nextCursor: cursor,
        preview: 'a'.repeat(TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES + 1),
        truncated: true,
        version: TOOL_OUTPUT_ARTIFACT_VERSION,
      })
    ).toBe(false);
    expect(encodeSpy).not.toHaveBeenCalled();

    expect(
      isToolOutputArtifactPage({
        artifactRef: largeReference,
        content: `"${'a'.repeat(TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES * 6 + 1)}"`,
        contentEncoding: TOOL_OUTPUT_ARTIFACT_JSON_STRING_ENCODING,
        endByte: 1,
        offsetByte: 0,
      })
    ).toBe(false);
    expect(parseSpy).not.toHaveBeenCalled();
    encodeSpy.mockRestore();
    parseSpy.mockRestore();
  });

  it('caps encoded provider fields as well as their decoded byte spans', () => {
    const inflated = encodeToolOutputArtifactContent(
      '\u0000'.repeat(TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES)
    );
    const inflatedReference = {
      ...reference,
      byteLength: TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES + 1,
    };

    expect(
      isToolOutputArtifactEnvelope({
        artifactRef: inflatedReference,
        code: TOOL_OUTPUT_ARTIFACT_CODE,
        contentEncoding: inflated.contentEncoding,
        hint: 'Continue.',
        nextCursor: cursor,
        preview: inflated.content,
        truncated: true,
        version: TOOL_OUTPUT_ARTIFACT_VERSION,
      })
    ).toBe(false);
    expect(
      isToolOutputArtifactPage({
        artifactRef: {
          ...inflatedReference,
          byteLength: TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
        },
        content: inflated.content,
        contentEncoding: inflated.contentEncoding,
        endByte: TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
        offsetByte: 0,
      })
    ).toBe(false);
  });
});
