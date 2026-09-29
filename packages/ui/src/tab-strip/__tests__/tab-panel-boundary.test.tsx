import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabPanelBoundary } from '../tab-panel-boundary';

let shouldThrow = true;
function Flaky({ name }: { readonly name: string }) {
  if (shouldThrow) {
    throw new Error(`${name} exploded`);
  }
  return <p>{name} content</p>;
}

describe('TabPanelBoundary', () => {
  let records: LogRecord[] = [];
  let removeListener: () => void = () => undefined;
  beforeEach(() => {
    shouldThrow = true;
    records = [];
    removeListener = addLogListener((record) => records.push(record));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    removeListener();
    vi.restoreAllMocks();
  });

  it('contains a render crash to the panel and keeps siblings alive', () => {
    render(
      <div>
        <TabPanelBoundary label="Changes">
          <Flaky name="Changes" />
        </TabPanelBoundary>
        <button type="button">Sibling</button>
      </div>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Changes stopped working');
    expect(screen.getByRole('alert')).toHaveTextContent('Changes exploded');
    expect(screen.getByRole('button', { name: 'Sibling' })).toBeEnabled();
    expect(records.some((record) => record.message === 'Tab panel crashed')).toBe(true);
  });

  it('remounts the subtree when "Reload tab" is pressed', () => {
    render(
      <TabPanelBoundary label="Canvas">
        <Flaky name="Canvas" />
      </TabPanelBoundary>
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reload tab' }));
    expect(screen.getByText('Canvas content')).toBeInTheDocument();
  });

  it('clears the error when resetKey changes', () => {
    function Host() {
      const [key, setKey] = useState('one');
      return (
        <>
          <button onClick={() => setKey('two')} type="button">
            Switch
          </button>
          <TabPanelBoundary label="Panel" resetKey={key}>
            <Flaky name="Panel" />
          </TabPanelBoundary>
        </>
      );
    }
    render(<Host />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
    expect(screen.getByText('Panel content')).toBeInTheDocument();
  });

  it('renders a one-row fallback in inline layout', () => {
    render(
      <TabPanelBoundary label="Tabs" layout="inline">
        <Flaky name="Tabs" />
      </TabPanelBoundary>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Tabs unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
