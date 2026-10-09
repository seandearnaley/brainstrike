/**
 * A producer with searchable conversation rows: a prompt is a user row, an
 * answer an assistant row, and a tool output is searchable event text only.
 * @typedef {{ seq: number, v: 1, type: 'prompt', runId: string, prompt: string } |
 * { seq: number, v: 1, type: 'answer', runId: string, text: string } |
 * { seq: number, v: 1, type: 'tool', output: string }} SearchEvent
 */
/** @type {import('@brainstrike/state-store').EventSchema<SearchEvent>} */
export const schema = {
  currentVersion: 1,
  upgraders: {},
  validate: (event, seq) => {
    if (
      event['type'] === 'prompt' &&
      typeof event['runId'] === 'string' &&
      typeof event['prompt'] === 'string'
    ) {
      return { prompt: event['prompt'], runId: event['runId'], seq, type: 'prompt', v: 1 };
    }
    if (
      event['type'] === 'answer' &&
      typeof event['runId'] === 'string' &&
      typeof event['text'] === 'string'
    ) {
      return { runId: event['runId'], seq, text: event['text'], type: 'answer', v: 1 };
    }
    if (event['type'] === 'tool' && typeof event['output'] === 'string') {
      return { output: event['output'], seq, type: 'tool', v: 1 };
    }
    return { invalid: `unknown event type ${JSON.stringify(event['type'])}` };
  },
};

/** @param {SearchEvent} event @returns {string} */
export function text(event) {
  if (event.type === 'prompt') {
    return event.prompt;
  }
  return event.type === 'answer' ? event.text : event.output;
}

/** @param {SearchEvent} event */
export function search(event) {
  if (event.type === 'prompt') {
    return { role: 'user', runId: event.runId, text: event.prompt };
  }
  if (event.type === 'answer') {
    return { role: 'assistant', runId: event.runId, text: event.text };
  }
  return null;
}
