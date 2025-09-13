import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ChatTransport, StreamChunk } from '../chat-panel';
import { ChatPanel } from '../chat-panel';

async function* mockTransport(): AsyncIterable<StreamChunk> {
  yield { type: 'tool-event', name: 'plan', status: 'start' };
  yield { type: 'text-delta', value: 'Hello' };
  yield { type: 'text-delta', value: ' world' };
  yield { type: 'tool-event', name: 'plan', status: 'success' };
}

describe('ChatPanel', () => {
  it('renders and streams messages via transport', async () => {
    const user = userEvent.setup();
    const transport: ChatTransport = () => mockTransport();

    render(<ChatPanel transport={transport} />);
    const input = screen.getByLabelText('Message');
    await user.type(input, 'hi');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // User message should appear
    expect(await screen.findByText(/You:/)).toBeInTheDocument();
    // Assistant streamed text should appear
    expect(await screen.findByText(/Assistant:/)).toBeInTheDocument();
    expect(await screen.findByText(/Hello world/)).toBeInTheDocument();
  });
});
