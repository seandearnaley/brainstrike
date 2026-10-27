import { createClipboardService } from '@brainstrike/context-actions';
import { createLogger } from '@brainstrike/logging';
import { toast } from '@brainstrike/ui';
import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { resolveBrowserBridge } from './browser-pane/browser-bridge';
import { openBrowserPage } from './browser-pane/browser-pages';
import { reportLinkFailure } from './link-failure';
import type { OpenLinkResult } from './open-external-link';

const logger = createLogger('LinkChoices');
const clipboard = createClipboardService();

/**
 * Where a web link can go besides the default browser. Each call shows its
 * own outcome and never rejects, so a surface only has to call it.
 */
export interface LinkChoices {
  readonly copyLink: (url: string) => Promise<OpenLinkResult>;
  /** Whether `url` can open in the built-in browser. */
  readonly offers: (url: string) => boolean;
  readonly openInAppBrowser: (url: string) => Promise<OpenLinkResult>;
}

/** The built-in browser shows web pages; every other link keeps its one destination. */
function isWebLink(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function failed(title: string, error: string, url: string): OpenLinkResult {
  const result = { error, ok: false };
  reportLinkFailure(title, result, url);
  return result;
}

/** A page of its own among the shown conversation's tabs; it is selected once main has it. */
async function openInAppBrowser(url: string): Promise<OpenLinkResult> {
  try {
    await openBrowserPage(url);
    return { ok: true };
  } catch (error) {
    return failed('Could not open link', getErrorMessage(error), url);
  }
}

async function copyLink(url: string): Promise<OpenLinkResult> {
  const outcome = await clipboard.writeText(url);
  if (!outcome.ok) {
    return failed('Could not copy link', outcome.error, url);
  }
  try {
    toast({ title: 'Link copied' });
  } catch (error) {
    logger.error('Failed to confirm a copied link', { error });
  }
  return { ok: true };
}

/**
 * The link choices this renderer can offer: null without the built-in
 * browser, so every link then opens in the default browser.
 */
export function resolveLinkChoices(): LinkChoices | null {
  return resolveBrowserBridge() ? { copyLink, offers: isWebLink, openInAppBrowser } : null;
}
