Object.defineProperty(exports, '__esModule', { value: true });
exports.InMemoryMemoryStore = void 0;
class InMemoryMemoryStore {
  conversations = new Map();
  append(conversationId, message) {
    const existing = this.conversations.get(conversationId);
    if (existing) {
      existing.messages.push(message);
      return;
    }
    this.conversations.set(conversationId, { id: conversationId, messages: [message] });
  }
  get(conversationId) {
    return this.conversations.get(conversationId);
  }
  list() {
    return Array.from(this.conversations.values());
  }
  reset() {
    this.conversations.clear();
  }
}
exports.InMemoryMemoryStore = InMemoryMemoryStore;
