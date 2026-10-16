import { createMcpAppToolInvocationResult, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import {
  decodeToolOutputArtifactCursor,
  type ToolOutputArtifactReference,
} from '@brainstrike/assistant-contract/tool-output-artifact';
import { describe, expect, it } from 'vitest';
import { resolveScaledToolResultBudget } from '../stream/tool-output-limits';
import { wouldTruncateMcpModelOutput } from '../tool-projection/tool-model-output';
import {
  TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES,
  TOOL_OUTPUT_ARTIFACT_SETTLEMENT_MAX_BYTES,
  toolOutputArtifactCandidate,
  toolOutputArtifactModelOutput,
} from '../tool-projection/tool-output-artifact-settlement';

/**
 * The settlement DECISION and the bounded first page it produces. Who stores
 * the artifact, and who resolves the reader, belongs to the host
 * (`agent-host/src/tool-artifacts.ts`) — the retired Mastra agent loop was the
 * other caller of these primitives, and ADR-0022 removed it.
 */

const ANCHOR_TOOL_RESULT_BUDGET = resolveScaledToolResultBudget(131_072);
const TEXT_ENCODER = new TextEncoder();

const reference = (byteLength: number): ToolOutputArtifactReference => ({
  byteLength,
  expiresAt: '2026-07-27T12:00:00.000Z',
  format: 'text',
  id: '019f7d67-7165-7c23-8e99-d70c2a2f168d',
});

const wouldTruncateAtAnchor = (toolName: string, output: unknown): boolean =>
  wouldTruncateMcpModelOutput(toolName, output, ANCHOR_TOOL_RESULT_BUDGET);

describe('tool output artifact settlement', () => {
  it('keeps an inline result inline and never nominates it for storage', () => {
    expect(toolOutputArtifactCandidate({ evidence: 'small' }, 'fixture', {})).toBeUndefined();
  });

  it.each([7900, 9042, 11_900, 12_500])(
    'preserves every byte of a %i-character MCP result inline or in storage',
    (length) => {
      const output =
        `${'x'.repeat(Math.floor(length / 2))}required-middle-criterion${'y'.repeat(length)}`.slice(
          0,
          length
        );

      const candidate = toolOutputArtifactCandidate(output, 'fixture', {
        wouldTruncateModelOutput: wouldTruncateAtAnchor,
      });

      if (length === 7900) {
        // The bounded projection still carries it complete, so it stays inline.
        expect(candidate).toBeUndefined();
        return;
      }
      expect(candidate?.serialized).toEqual({
        byteLength: TEXT_ENCODER.encode(output).byteLength,
        content: output,
        format: 'text',
      });
    }
  );

  it.each([0, 16, 9042, 12_500])(
    'keeps an MCP Apps marker out of the artifact and settles only its result at %i chars',
    (length) => {
      const marker = createMcpAppToolInvocationResult(
        {
          mimeType: 'text/html;profile=mcp-app',
          resourceUri: 'ui://issues/detail',
          serverId: 'remote',
          toolName: 'show_issue',
        },
        length === 0 ? null : { description: 'x'.repeat(length), issueId: 'BST-1572' }
      );

      const candidate = toolOutputArtifactCandidate(marker, 'fixture', {
        wouldTruncateModelOutput: wouldTruncateAtAnchor,
      });

      if (length <= 16) {
        expect(candidate).toBeUndefined();
        return;
      }
      // The renderer-owned marker never reaches storage: only the inner result does.
      expect(candidate?.isAppResult).toBe(true);
      expect(candidate?.serialized.content).toBe(JSON.stringify(marker.result));
      expect(candidate?.serialized.format).toBe('json');
      expect(candidate?.serialized.content).not.toContain('mcp-app');
    }
  );

  it('settles a tool above its stricter serialized-character threshold', () => {
    const output = { payload: '雪\\n"quoted" 😀'.repeat(400) };
    const serialized = JSON.stringify(output);
    expect(TEXT_ENCODER.encode(serialized).byteLength).toBeLessThan(
      TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES
    );

    const options = {
      inlineMaxSerializedCharsByToolName: new Map([['brainstrike.webExtract', 1000]]),
    };

    expect(
      toolOutputArtifactCandidate(output, 'brainstrike.webExtract', options)?.serialized.content
    ).toBe(serialized);
    // The stricter ceiling is per tool name, never global.
    expect(toolOutputArtifactCandidate(output, 'other.tool', options)).toBeUndefined();
  });

  it('does not publish an EOF cursor when an artifact fits one page', () => {
    const content = JSON.stringify({ payload: 'x'.repeat(3000) });
    const byteLength = TEXT_ENCODER.encode(content).byteLength;

    const model = toolOutputArtifactModelOutput({
      content,
      readerToolName: NATIVE_TOOL_ID.readToolOutputArtifact,
      reference: reference(byteLength),
    });

    expect(model).toMatchObject({
      type: 'json',
      value: { complete: true, endByte: byteLength, offsetByte: 0 },
    });
    expect(JSON.stringify(model)).not.toContain('nextCursor');
    expect(JSON.stringify(model)).not.toContain('readToolOutputArtifact');
  });

  it('hands the model a bounded first page that can page the rest', () => {
    const content = `head-${'x'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES)}-tail`;
    const artifact = reference(TEXT_ENCODER.encode(content).byteLength);

    const model = toolOutputArtifactModelOutput({
      content,
      readerToolName: NATIVE_TOOL_ID.readToolOutputArtifact,
      reference: artifact,
    });

    const encoded = JSON.stringify(model);
    expect(model).toMatchObject({ type: 'json' });
    expect(encoded).toContain(NATIVE_TOOL_ID.readToolOutputArtifact);
    expect(encoded).toContain('"cursor":"bsto1.');
    // The page never leaks the raw reference, and stays well inside the envelope.
    expect(encoded).not.toContain('artifactRef');
    expect(encoded).not.toContain('output was truncated');
    expect(encoded.length).toBeLessThanOrEqual(8000);

    const cursor = encoded.match(/"cursor":"(bsto1\.[^"]+)"/)?.[1];
    if (!cursor) {
      throw new TypeError('Expected a continuation cursor in the bounded page.');
    }
    expect(decodeToolOutputArtifactCursor(cursor)).toEqual({
      artifactRef: artifact,
      offsetByte: expect.any(Number),
    });
  });

  it.each([false, true])('preserves oversized MCP media inline (Apps: %s)', (isApp) => {
    const ordinary = {
      content: [
        { text: 'A rendered image.', type: 'text' },
        {
          data: 'a'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES),
          mimeType: 'image/png',
          type: 'image',
        },
      ],
    };
    const output = isApp
      ? createMcpAppToolInvocationResult(
          {
            mimeType: 'text/html;profile=mcp-app',
            resourceUri: 'ui://image/detail',
            serverId: 'remote',
            toolName: 'show_image',
          },
          ordinary
        )
      : ordinary;

    expect(toolOutputArtifactCandidate(output, 'fixture', {})).toBeUndefined();
  });

  it('rejects an output above the explicit settlement cap instead of nominating it', () => {
    let thrown: unknown;
    try {
      toolOutputArtifactCandidate(
        'x'.repeat(TOOL_OUTPUT_ARTIFACT_SETTLEMENT_MAX_BYTES + 1),
        'fixture',
        {}
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: 'ToolOutputArtifactSettlementError',
      reason: 'output_too_large',
    });
  });
});
