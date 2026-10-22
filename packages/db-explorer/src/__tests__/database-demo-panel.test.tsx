import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DatabaseDemoPanel } from '../database-demo-panel';

const nativePanel = vi.hoisted(() => ({ onDatabaseCleared: null as (() => void) | null }));
vi.mock('../components/native-library-panel', () => ({
  NativeLibraryPanel: (props: { onDatabaseCleared: (() => void) | null }) => {
    nativePanel.onDatabaseCleared = props.onDatabaseCleared;
    return <div data-testid="native-library" />;
  },
}));

it('forwards the existing conversation retirement callback to native Library', () => {
  const retire = vi.fn();
  vi.stubGlobal('sourceFiles', {
    chunks: vi.fn(),
    delete: vi.fn(),
    import: vi.fn(),
    list: vi.fn(),
    read: vi.fn(),
  });
  try {
    render(<DatabaseDemoPanel onDatabaseCleared={retire} />);
    expect(screen.getByTestId('native-library')).toBeTruthy();
    expect(nativePanel.onDatabaseCleared).toBe(retire);
  } finally {
    vi.unstubAllGlobals();
  }
});
