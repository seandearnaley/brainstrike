import type { IFileNode } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NodeIcon } from '../node-icon';

describe('NodeIcon', () => {
  const fileNode = {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: 'test.txt',
    path: '/test.txt',
    rootFolderId: 'root',
    selectionState: 'unchecked' as const,
    type: 'file' as const,
  } as IFileNode;

  const directoryNode = {
    children: [],
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    name: 'src',
    path: '/src',
    rootFolderId: 'root',
    selectionState: 'unchecked' as const,
    type: 'directory' as const,
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
