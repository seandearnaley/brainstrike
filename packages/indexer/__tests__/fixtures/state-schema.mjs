/**
 * @typedef {{ seq: number, v: 2, type: 'text', content: string } |
 * { seq: number, v: 2, type: 'tool-result', output: string } |
 * { seq: number, v: 2, type: 'tool-result', preview: string, blob: string }} FixtureEvent
 */
/** @type {import('@brainstrike/state-store').EventSchema<FixtureEvent>} */
export const schema = {
  currentVersion: 2,
  upgraders: {
    1: (event) => {
      if (event['type'] === 'text') {
        const { text, ...rest } = event;
        return { ...rest, content: text, v: 2 };
      }
      return { ...event, v: 2 };
    },
  },
  validate: (event, seq) => {
    if (event['type'] === 'text' && typeof event['content'] === 'string') {
      return { content: event['content'], seq, type: 'text', v: 2 };
    }
    if (event['type'] === 'tool-result') {
      if (typeof event['output'] === 'string') {
        return { output: event['output'], seq, type: 'tool-result', v: 2 };
      }
      if (typeof event['preview'] === 'string' && typeof event['blob'] === 'string') {
        return { blob: event['blob'], preview: event['preview'], seq, type: 'tool-result', v: 2 };
      }
    }
    return { invalid: `unknown event type ${JSON.stringify(event['type'])}` };
  },
};

/** @param {unknown} event @returns {string} */
export function text(event) {
  if (typeof event !== 'object' || event === null) {
    throw new TypeError('Expected fixture event');
  }
  if ('content' in event && typeof event.content === 'string') {
    return event.content;
  }
  if ('output' in event && typeof event.output === 'string') {
    return event.output;
  }
  if ('preview' in event && typeof event.preview === 'string') {
    return event.preview;
  }
  throw new TypeError('Expected recognized fixture text');
}
