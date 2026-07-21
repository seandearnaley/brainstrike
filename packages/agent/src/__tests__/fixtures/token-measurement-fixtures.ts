export const TOKEN_MEASUREMENT_FIXTURES = [
  {
    name: 'json',
    o200kTokens: 20,
    text: '{"ok":true,"items":[1,2,3],"nested":{"name":"brainstrike"}}',
  },
  {
    name: 'code',
    o200kTokens: 19,
    text: 'export function add(a: number, b: number): number { return a + b; }',
  },
  {
    name: 'cjk',
    o200kTokens: 13,
    text: '工具调用应该保持精确、可观察且高效。',
  },
  {
    name: 'emoji',
    o200kTokens: 14,
    text: 'agent tools 🧠⚡️🛠️ stay bounded',
  },
  {
    name: 'escaped strings',
    o200kTokens: 15,
    text: '{"text":"line one\\nline two\\t\\"quoted\\"\\\\path"}',
  },
  {
    name: 'media marker',
    o200kTokens: 15,
    text: '[image-data payload omitted from token count; media type: image/png]',
  },
] as const;
