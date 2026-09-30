import type { ChangedFileStatus } from '@brainstrike/types';

interface GitStatusPresentation {
  readonly className: string;
  readonly glyph: string;
  readonly label: string;
}

const PRESENTATIONS = new Map<string, GitStatusPresentation>([
  ['A', { className: 'text-success', glyph: 'A', label: 'Added file' }],
  ['C', { className: 'text-info', glyph: 'C', label: 'Copied file' }],
  ['D', { className: 'text-destructive', glyph: 'D', label: 'Deleted file' }],
  ['M', { className: 'text-warning', glyph: 'M', label: 'Modified file' }],
  ['R', { className: 'text-info', glyph: 'R', label: 'Renamed file' }],
  ['T', { className: 'text-warning', glyph: 'T', label: 'File type changed' }],
  ['U', { className: 'text-warning', glyph: 'U', label: 'Unmerged file' }],
  ['?', { className: 'text-success', glyph: '?', label: 'Untracked file' }],
]);

export function gitStatusPresentation(status: string): GitStatusPresentation {
  const known = PRESENTATIONS.get(status);
  return (
    known ?? {
      className: 'text-warning',
      glyph: status,
      label: status ? `Git status ${status}` : 'Unknown Git status',
    }
  );
}

export const CHANGED_FILE_STATUS_PRESENTATION: Record<ChangedFileStatus, GitStatusPresentation> = {
  added: gitStatusPresentation('A'),
  deleted: gitStatusPresentation('D'),
  modified: gitStatusPresentation('M'),
  renamed: gitStatusPresentation('R'),
  untracked: gitStatusPresentation('?'),
};
