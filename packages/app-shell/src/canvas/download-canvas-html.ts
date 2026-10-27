import {
  downloadBlobFile,
  formatTimestampedDownloadFilename,
  sanitizeFilenameSegment,
} from '@brainstrike/utils/browser-download';

const MAX_NAME_LENGTH = 60;

/**
 * Saves one canvas version as a standalone `.html` file, so it opens in any
 * browser and can be passed to someone else. The charset declaration comes
 * first because a canvas is often a fragment, and a browser opening a local
 * file without one guesses the encoding. Resolves the saved path when the
 * platform reports one; rejects when the save fails.
 */
export async function downloadCanvasHtml(canvas: {
  readonly html: string;
  readonly title: string;
  readonly version: number;
}): Promise<{ readonly path?: string }> {
  const name =
    sanitizeFilenameSegment(canvas.title.trim().replace(/\s+/gu, '-')).slice(0, MAX_NAME_LENGTH) ||
    'canvas';
  return await downloadBlobFile({
    blob: new Blob([`<!doctype html>\n<meta charset="utf-8">\n${canvas.html}`], {
      type: 'text/html',
    }),
    filename: formatTimestampedDownloadFilename({
      extension: 'html',
      generatedAt: new Date(),
      name,
      suffix: `v${canvas.version}`,
    }),
  });
}
