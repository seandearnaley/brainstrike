import type { IFileNode } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NodeIcon } from '../node-icon';

describe('NodeIcon', () => {
  const fileNode = {
    name: 'test.txt',
    path: '/test.txt',
    type: 'file' as const,
    isVisible: true,
    handle: {} as FileSystemFileHandle,
    depth: 0,
    selectionState: 'unchecked' as const,
    rootFolderId: 'root',
  } as IFileNode;

  const directoryNode = {
    name: 'src',
    path: '/src',
    type: 'directory' as const,
    isVisible: true,
    children: [],
    handle: {} as FileSystemDirectoryHandle,
    depth: 0,
    selectionState: 'unchecked' as const,
    rootFolderId: 'root',
  } as IFileNode;

  it('renders loading spinner when isLoading is true', () => {
    render(<NodeIcon isExpanded={false} isLoading={true} node={fileNode} />);

    const loader = screen.getByLabelText('Loading test.txt');
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveClass('animate-spin');
  });

  it('renders file icon for file nodes', () => {
    const { container } = render(<NodeIcon isExpanded={false} isLoading={false} node={fileNode} />);

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveClass('text-gray-500');
  });

  it('renders folder icon when directory is collapsed', () => {
    const { container } = render(
      <NodeIcon isExpanded={false} isLoading={false} node={directoryNode} />
    );

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveClass('text-blue-500');
  });

  it('renders open folder icon when directory is expanded', () => {
    const { container } = render(
      <NodeIcon isExpanded={true} isLoading={false} node={directoryNode} />
    );

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveClass('text-blue-500');
  });

  it('renders null for unknown node type', () => {
    const unknownNode = {
      ...fileNode,
      type: 'unknown' as 'file',
    };

    const { container } = render(
      <NodeIcon isExpanded={false} isLoading={false} node={unknownNode} />
    );

    expect(container.firstChild).toBeNull();
  });

  it('prioritizes loading state over node type', () => {
    render(<NodeIcon isExpanded={true} isLoading={true} node={directoryNode} />);

    const loader = screen.getByLabelText('Loading src');
    expect(loader).toBeInTheDocument();
  });
});
