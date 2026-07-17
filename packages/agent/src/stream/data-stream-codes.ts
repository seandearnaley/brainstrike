export const DataStreamCode = {
  auiDataPart: 'aui-data',
  data: '2',
  error: '3',
  finishMessage: 'd',
  finishStep: 'e',
  reasoningDelta: 'g',
  startStep: 'f',
  startToolCall: 'b',
  textDelta: '0',
  toolCall: '9',
  toolCallArgsTextDelta: 'c',
  toolCallResult: 'a',
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
