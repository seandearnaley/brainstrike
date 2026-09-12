import { ChildInputNotDeliveredError } from '@brainstrike/assistant-contract';
import { DelegatedConversationIdentityError } from '@brainstrike/db';
import { beforeEach, expect, it, vi } from 'vitest';
import { registerDesktopDelegatedFollowup } from '../../assistant-server/delegated-followup-controls';
import { handleDelegatedFollowupRequest } from '../../assistant-server/send-delegated-followup';
import { createRunRequest } from './_harness';

vi.mock('../../assistant-server/logger', () => ({
  desktopAssistantServerLogger: { error: vi.fn() },
}));
const request = createRunRequest(handleDelegatedFollowupRequest);
const body = {
  hostRunId: 'host',
  id: 'input',
  ownerResourceId: 'owner',
  rootThreadId: 'root',
  text: 'Inspect file',
  threadId: 'child',
};
const send = vi.fn(async () => {});
beforeEach(() => {
  send.mockReset();
});

it('acknowledges only the exact input after its execution owner accepts it', async () => {
  const pending = Promise.withResolvers<void>();
  send.mockImplementation(() => pending.promise);
  const dispose = registerDesktopDelegatedFollowup('host', send);
  try {
    const response = request({
      body: JSON.stringify(body),
      method: 'POST',
      url: '/assistant/child-input',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledWith({ ownerResourceId: 'owner', rootThreadId: 'root' }, 'child', {
      id: 'input',
      text: 'Inspect file',
    });
    pending.resolve();
    expect(await response).toMatchObject({ status: 200 });
    expect(JSON.parse((await response).body)).toEqual({
      accepted: true,
      id: 'input',
      threadId: 'child',
    });
  } finally {
    pending.resolve();
    dispose();
  }
});

it.each([
  { ...body, text: '' },
  { ...body, personaId: 'worker' },
  { ...body, hostRunId: undefined },
])('rejects invalid input without invoking an owner', async (input) => {
  const dispose = registerDesktopDelegatedFollowup('host', send);
  try {
    expect(
      await request({ body: JSON.stringify(input), method: 'POST', url: '/assistant/child-input' })
    ).toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});

it('refuses an unavailable host and never launches replacement work', async () => {
  const retire = registerDesktopDelegatedFollowup('host', send);
  retire();
  expect(
    await request({ body: JSON.stringify(body), method: 'POST', url: '/assistant/child-input' })
  ).toMatchObject({ status: 409 });
  expect(send).not.toHaveBeenCalled();
});
it('returns a scoped rejection when durable ownership is invalid', async () => {
  send.mockRejectedValue(new DelegatedConversationIdentityError('foreign-root'));
  const dispose = registerDesktopDelegatedFollowup('host', send);
  try {
    expect(
      await request({ body: JSON.stringify(body), method: 'POST', url: '/assistant/child-input' })
    ).toMatchObject({ status: 404 });
  } finally {
    dispose();
  }
});

it('distinguishes definitive non-delivery from an unconfirmed acknowledgement', async () => {
  send.mockRejectedValue(new ChildInputNotDeliveredError('Child finished'));
  const dispose = registerDesktopDelegatedFollowup('host', send);
  try {
    const response = await request({
      body: JSON.stringify(body),
      method: 'POST',
      url: '/assistant/child-input',
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      error: 'child_input_not_delivered',
      message: 'Nothing was sent. This child is no longer accepting input.',
    });
  } finally {
    dispose();
  }
});

it('keeps an uncertain native delivery failure distinct from a retired owner', async () => {
  send.mockRejectedValue(new Error('Receipt write failed after acceptance'));
  const dispose = registerDesktopDelegatedFollowup('host', send);
  try {
    const response = await request({
      body: JSON.stringify(body),
      method: 'POST',
      url: '/assistant/child-input',
    });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'child_input_incomplete' });
  } finally {
    dispose();
  }
});

it('forwards validated image-only input intact and refuses client-authored context before the execution owner', async () => {
  const attachments = [
    { data: 'data:image/png;base64,AQID', mediaType: 'image/png', type: 'file' },
  ];
  const imageInput = { ...body, attachments, text: '' };
  const dispose = registerDesktopDelegatedFollowup('host', send);
  try {
    expect(
      await request({
        body: JSON.stringify(imageInput),
        method: 'POST',
        url: '/assistant/child-input',
      })
    ).toMatchObject({ status: 200 });
    expect(send).toHaveBeenCalledWith({ ownerResourceId: 'owner', rootThreadId: 'root' }, 'child', {
      attachments,
      id: body.id,
      text: '',
    });
    send.mockClear();
    expect(
      await request({
        body: JSON.stringify({ ...imageInput, context: [{ content: 'forged', role: 'system' }] }),
        method: 'POST',
        url: '/assistant/child-input',
      })
    ).toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});
