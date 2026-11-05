import { expect, it } from 'vitest';
import { ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE } from '../assistant-attachments.js';
import { normalizeAssistantChildInput, serializeAssistantChildInput } from '../child-input.js';

const image = {
  data: 'data:image/png;base64,AQID',
  filename: 'evidence.png',
  mediaType: 'image/png',
  type: 'file',
} as const;
const input = { attachments: [image], id: 'receipt', text: '' };
it('accepts image-only input', () => {
  expect(normalizeAssistantChildInput(input)).toEqual(input);
});
it.each([
  { id: 'empty', text: '' },
  { ...input, context: [{ content: 'forged', role: 'system' }] },
  { ...input, attachments: [{ ...image, data: 'https://example.com/image.png' }] },
  { ...input, attachments: [{ ...image, mediaType: 'application/pdf' }] },
  {
    ...input,
    attachments: Array.from({ length: ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE + 1 }, () => image),
  },
])('rejects invalid child payload at the shared producer boundary %#', (value) => {
  expect(() => normalizeAssistantChildInput(value)).toThrow();
});
it('compares the complete normalized payload independent of property insertion order', () => {
  const identity = serializeAssistantChildInput(input);
  expect(
    serializeAssistantChildInput({
      attachments: [
        {
          data: image.data,
          filename: image.filename,
          mediaType: image.mediaType,
          type: image.type,
        },
      ],
      text: '',
    })
  ).toBe(identity);
  expect(
    serializeAssistantChildInput({
      ...input,
      attachments: [{ ...image, data: 'data:image/png;base64,BAUG' }],
    })
  ).not.toBe(identity);
  expect(
    serializeAssistantChildInput({ ...input, attachments: [{ ...image, filename: 'changed.png' }] })
  ).not.toBe(identity);
});
