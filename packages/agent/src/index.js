Object.defineProperty(exports, '__esModule', { value: true });
exports.streamPlanThenAct = exports.InMemoryMemoryStore = void 0;
exports.streamEcho = streamEcho;
exports.createDevChatAgent = createDevChatAgent;
exports.toAiSdkStyleStream = toAiSdkStyleStream;
const planThenAct1 = require('./workflows/plan-then-act');
// Minimal placeholder agent: echoes user text in a streamed fashion.
async function* streamEcho(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const text = last?.parts.find((p) => p.type === 'text');
  const content = text?.text ?? '';
  yield { type: 'tool-event', name: 'plan', status: 'start' };
  for (const token of content.split(/(\s+)/)) {
    if (token.length === 0) continue;
    yield { type: 'text-delta', value: token };
    await new Promise((r) => setTimeout(r, 5));
  }
  yield {
    type: 'tool-event',
    name: 'plan',
    status: 'success',
    payload: { tokens: content.length },
  };
}
// Memory store for early development
var inMemory1 = require('./memory/in-memory');
Object.defineProperty(exports, 'InMemoryMemoryStore', {
  enumerable: true,
  get: () => inMemory1.InMemoryMemoryStore,
});
// Plan-then-act workflow
var planThenAct2 = require('./workflows/plan-then-act');
Object.defineProperty(exports, 'streamPlanThenAct', {
  enumerable: true,
  get: () => planThenAct2.streamPlanThenAct,
});
function createDevChatAgent() {
  return {
    id: 'chat',
    instructions: 'You are a helpful, step-by-step assistant.',
    stream: (messages, runtime) => planThenAct1.streamPlanThenAct(messages, runtime),
  };
}
// Adapter to Vercel AI SDK v5 style data stream if needed by routes
async function toAiSdkStyleStream(messages, runtime) {
  // For now, use the plan-then-act workflow to demonstrate multi-step output.
  return planThenAct1.streamPlanThenAct(messages, runtime);
}
