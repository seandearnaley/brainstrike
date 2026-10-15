// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  selectCommittedAssistantMessage,
  selectCommittedAssistantPart,
  selectCommittedAssistantTool,
} from '../committed-assistant-store';
import { PublishedConversation, recordedMessage } from './committed-assistant-test-support';

describe('committed assistant selectors', () => {
  it('retains the recorded rich part objects and missing identities remain missing', async () => {
    const message = await recordedMessage();
    const store = new PublishedConversation('root', [message]);
    expect(selectCommittedAssistantMessage(store.getSnapshot(), message.id)).toBe(message);
    for (let index = 0; index < message.content.length; index += 1) {
      expect(selectCommittedAssistantPart(store.getSnapshot(), message.id, index)).toBe(
        message.content[index]
      );
    }
    expect(message.content.some((part) => part.type === 'data')).toBe(true);
    expect(selectCommittedAssistantMessage(store.getSnapshot(), 'unknown')).toBeUndefined();
    expect(selectCommittedAssistantPart(store.getSnapshot(), message.id, 999)).toBeUndefined();
    expect(
      selectCommittedAssistantTool(store.getSnapshot(), message.id, 'unknown')
    ).toBeUndefined();
  });
});
