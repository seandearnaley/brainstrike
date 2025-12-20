import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { describe, expect, it } from 'vitest';
import { readBody } from '../assistant-stream-helpers';

describe('assistant-stream-helpers', () => {
  it('reads the request body as a string', async () => {
    const req = new EventEmitter() as http.IncomingMessage;
    const bodyPromise = readBody(req);

    req.emit('data', Buffer.from('hello '));
    req.emit('data', Buffer.from('world'));
    req.emit('end');

    await expect(bodyPromise).resolves.toBe('hello world');
  });
});
