interface McpContentPart {
  readonly data?: unknown;
  readonly mimeType?: unknown;
  readonly text?: unknown;
  readonly type?: unknown;
}

interface McpMultimodalOutput {
  readonly content: readonly McpContentPart[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function isMcpMediaPart(part: McpContentPart): boolean {
  return (part.type === 'image' || part.type === 'audio') && typeof part.data === 'string';
}

export function readMcpMultimodalOutput(output: unknown): McpMultimodalOutput | undefined {
  if (!(output && typeof output === 'object')) {
    return;
  }
  const content = (output as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  const parts = content.filter((part): part is McpContentPart => isRecord(part));
  if (!parts.some(isMcpMediaPart)) {
    return;
  }
  if (parts.length !== content.length) {
    throw new TypeError('MCP multimodal content must contain only object parts');
  }
  return { content: parts };
}

export function measureMcpMultimodalOutput(output: unknown):
  | {
      readonly mediaDataChars: number;
      readonly nonMediaSerializedChars: number;
    }
  | undefined {
  const multimodal = readMcpMultimodalOutput(output);
  if (!multimodal) {
    return;
  }
  let mediaDataChars = 0;
  const maskedContent = multimodal.content.map((part) => {
    if (!isMcpMediaPart(part)) {
      return part;
    }
    mediaDataChars += String(part.data).length;
    return { ...part, data: '' };
  });
  const maskedOutput = { ...(output as Record<string, unknown>), content: maskedContent };
  const serialized = JSON.stringify(maskedOutput);
  if (serialized === undefined) {
    throw new TypeError('MCP tool output could not be serialized');
  }
  return {
    mediaDataChars,
    nonMediaSerializedChars: serialized.length,
  };
}

export type { McpContentPart, McpMultimodalOutput };
