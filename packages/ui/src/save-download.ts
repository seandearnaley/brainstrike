import { downloadBlobFile } from '@brainstrike/utils/browser-download';
import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { toast } from './use-toast';

/** A file ready to save: its bytes and the name it asks for. */
export interface DownloadFile {
  readonly blob: Blob;
  readonly filename: string;
}

/**
 * Builds a file, saves it to the person's Downloads folder, and says so in a
 * toast: "<What> saved" with the path it was saved at (desktop never
 * overwrites, so the path can differ from the asked-for name), or "Could not
 * save the <what>" with the reason. Every download and export goes through
 * here, so each one confirms the same way and none fails silently. Building is
 * inside the same guard, so a file that fails to build reports like one that
 * fails to save.
 *
 * Resolves whether the file was saved; it never rejects.
 */
export async function saveDownload({
  build,
  what,
}: {
  readonly build: () => DownloadFile | Promise<DownloadFile>;
  /** Lower-case noun for the toast, e.g. "debug pack". */
  readonly what: string;
}): Promise<boolean> {
  try {
    const built = build();
    // A file built in the click's own task is saved in it too, so the web
    // route's anchor click still carries the person's gesture.
    const { blob, filename } = built instanceof Promise ? await built : built;
    const { path } = await downloadBlobFile({ blob, filename });
    toast({
      description: path ?? filename,
      title: `${what.charAt(0).toUpperCase()}${what.slice(1)} saved`,
    });
    return true;
  } catch (error) {
    toast({
      description: getErrorMessage(error),
      title: `Could not save the ${what}`,
      variant: 'destructive',
    });
    return false;
  }
}
