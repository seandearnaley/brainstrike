export const DataStreamCode = {
  textDelta: '0',
  data: '2',
  error: '3',
  reasoningDelta: 'g',
  auiDataPart: 'aui-data',
  toolCall: '9',
  toolCallResult: 'a',
  startToolCall: 'b',
  toolCallArgsTextDelta: 'c',
  finishMessage: 'd',
  finishStep: 'e',
  startStep: 'f',
} as const;
export type DataStreamCode = (typeof DataStreamCode)[keyof typeof DataStreamCode];

export interface EncodedChunk {
  code: DataStreamCode;
  value: unknown;
}

export interface StoredChunk {
  chunk: EncodedChunk;
  payload: Uint8Array;
  sequence: number;
}

const encoder = new TextEncoder();

export function encodeChunk({ code, value }: EncodedChunk): Uint8Array {
  return encoder.encode(`${code}:${JSON.stringify(value)}\n`);
}
