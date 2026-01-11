import type { AgentMessage } from '../index';

export interface Conversation {
  id: string;
  messages: AgentMessage[];
}

export class InMemoryMemoryStore {
  private readonly conversations = new Map<string, Conversation>();

  append(conversationId: string, message: AgentMessage) {
    const existing = this.conversations.get(conversationId);
    if (existing) {
      existing.messages.push(message);
      return;
    }
    this.conversations.set(conversationId, { id: conversationId, messages: [message] });
  }

  get(conversationId: string): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  list(): Conversation[] {
    return Array.from(this.conversations.values());
  }

  reset() {
    this.conversations.clear();
  }
}
