export function formatPreviewFileSize(bytes?: number): string {
  if (bytes === undefined) {
    return '—';
  }

  return `${(bytes / 1024).toFixed(1)} KB`;
}
