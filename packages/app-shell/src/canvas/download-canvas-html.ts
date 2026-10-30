import type { DownloadFile } from '@brainstrike/ui';
import {
  formatTimestampedDownloadFilename,
  sanitizeFilenameSegment,
} from '@brainstrike/utils/browser-download';

const MAX_NAME_LENGTH = 60;

/**
 * One canvas version as a standalone `.html` file, so it opens in any browser
 * and can be passed to someone else. The charset declaration comes first
 * because a canvas is often a fragment, and a browser opening a local file
 * without one guesses the encoding.
 */
export function canvasHtmlFile(canvas: {
  readonly html: string;
  readonly title: string;
  readonly version: number;
}): DownloadFile {
  const name =
    sanitizeFilenameSegment(canvas.title.trim().replace(/\s+/gu, '-')).slice(0, MAX_NAME_LENGTH) ||
    'canvas';
  return {
    blob: new Blob([`<!doctype html>\n<meta charset="utf-8">\n${canvas.html}`], {
      type: 'text/html',
    }),
    filename: formatTimestampedDownloadFilename({
      extension: 'html',
      generatedAt: new Date(),
      name,
      suffix: `v${canvas.version}`,
    }),
  };
}
