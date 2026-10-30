/**
 * {@link BrowserDriver} over a CDP {@link CdpSession} — in production the
 * session wraps one page's `webContents.debugger` (BST-1176). The session is
 * resolved PER CALL, so a page closed since the driver was made rejects the
 * call instead of reaching a stale handle.
 */
import {
  type AccessibilitySnapshot,
  type AxSnapshotNode,
  formatAccessibilitySnapshot,
  type SnapshotOptions,
} from './accessibility-snapshot';
import { type ActionTargetFacts, decodeTargetFacts } from './browser-action-guard';
import {
  BrowserActionError,
  type BrowserDriver,
  type CdpSession,
  type CdpSessionResolver,
  type DriverPageText,
  type DriverScreenshot,
  type PaneRegion,
} from './browser-driver';
import {
  FILL_FUNCTION,
  HIT_TEST_FUNCTION,
  SELECT_OPTIONS_FUNCTION,
  TARGET_FACTS_FUNCTION,
} from './browser-page-functions';

interface AxTreeResult {
  readonly nodes?: readonly unknown[];
}

/** An `AXValue` the formatter reads: an object whose `value` (if present) is a primitive. */
function isAxValue(candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const { value } = candidate as { value?: unknown };
  return (
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function isStringArray(candidate: unknown): boolean {
  return Array.isArray(candidate) && candidate.every((item) => typeof item === 'string');
}

/**
 * A well-formed AX node: a string `nodeId` AND every OTHER field the formatter
 * consumes must, when present, have the right type — a `backendDOMNodeId` that
 * is a string would otherwise become a string-valued ref, and a malformed
 * `role` would silently drop content. NO SILENT FALLBACKS: any mismatch means a
 * broken transport, so the caller rejects rather than degrading.
 */
function isAxNode(node: unknown): node is AxSnapshotNode {
  if (typeof node !== 'object' || node === null) {
    return false;
  }
  const n = node as Record<string, unknown>;
  if (typeof n['nodeId'] !== 'string') {
    return false;
  }
  const backendId = n['backendDOMNodeId'];
  if (backendId !== undefined && typeof backendId !== 'number') {
    return false;
  }
  const ignored = n['ignored'];
  if (ignored !== undefined && typeof ignored !== 'boolean') {
    return false;
  }
  const childIds = n['childIds'];
  if (childIds !== undefined && !isStringArray(childIds)) {
    return false;
  }
  const role = n['role'];
  const name = n['name'];
  return (role === undefined || isAxValue(role)) && (name === undefined || isAxValue(name));
}

interface CaptureScreenshotResult {
  readonly data?: string;
}

interface EvaluateResult {
  readonly exceptionDetails?: {
    readonly exception?: { readonly description?: string };
    readonly text?: string;
  };
  readonly result?: { readonly value?: unknown };
}

interface FrameTreeResult {
  readonly frameTree?: { readonly frame?: { readonly loaderId?: unknown } };
}

interface ContentQuadsResult {
  readonly quads?: readonly (readonly number[])[];
}

/** One release per action for every handle it resolved. */
const ACTION_OBJECT_GROUP = 'brainstrike-agent-action';

/** CDP's reply when a backend node id names no live node. */
const STALE_NODE = /no node|could not find node|node with given id/iu;

/** A key event pair for one named key. */
const ENTER = { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 } as const;
const DELETE = { code: 'Delete', key: 'Delete', windowsVirtualKeyCode: 46 } as const;

export class DebuggerBrowserDriver implements BrowserDriver {
  private readonly resolveSession: CdpSessionResolver;

  constructor(resolveSession: CdpSessionResolver) {
    this.resolveSession = resolveSession;
  }

  async snapshot(options: SnapshotOptions): Promise<AccessibilitySnapshot> {
    const session = await this.resolveSession();
    // getFullAXTree requires the Accessibility domain enabled; it is idempotent.
    await session.send('Accessibility.enable');
    const tree = await session.send<AxTreeResult>('Accessibility.getFullAXTree');
    // NO SILENT FALLBACKS: a malformed reply (protocol skew, broken transport)
    // must surface as a capability failure, never a plausible "empty page" —
    // validate the array AND every element's shape (a `[{}]` would otherwise
    // format as a valid empty snapshot).
    const nodes = tree?.nodes;
    if (!Array.isArray(nodes)) {
      throw new Error('CDP Accessibility.getFullAXTree returned no nodes array');
    }
    if (!nodes.every(isAxNode)) {
      throw new Error('CDP Accessibility.getFullAXTree returned a malformed node');
    }
    return formatAccessibilitySnapshot(nodes, options);
  }

  async screenshot(options?: { readonly region?: PaneRegion }): Promise<DriverScreenshot> {
    const session = await this.resolveSession();
    // A region clip is in DOCUMENT coordinates (see PaneRegion); capture beyond
    // the viewport so a region below the fold still renders.
    const params = options?.region
      ? { captureBeyondViewport: true, clip: toClip(options.region) }
      : undefined;
    const shot = await session.send<CaptureScreenshotResult>('Page.captureScreenshot', params);
    if (typeof shot?.data !== 'string' || shot.data.length === 0) {
      throw new Error('CDP Page.captureScreenshot returned no image data');
    }
    return { dataUrl: `data:image/png;base64,${shot.data}` };
  }

  async getPageText(maxChars: number): Promise<DriverPageText> {
    const session = await this.resolveSession();
    const evaluated = await session.send<EvaluateResult>('Runtime.evaluate', {
      // Always resolves to a string (empty when body is absent) — so a
      // non-string here means the CALL failed, not that the page is empty.
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    });
    const value = evaluated?.result?.value;
    if (typeof value !== 'string') {
      throw new Error('CDP Runtime.evaluate did not return page text');
    }
    const truncated = value.length > maxChars;
    return { text: truncated ? value.slice(0, maxChars) : value, truncated };
  }

  async documentId(): Promise<string> {
    const session = await this.resolveSession();
    const tree = await session.send<FrameTreeResult>('Page.getFrameTree');
    const loaderId = tree?.frameTree?.frame?.loaderId;
    if (typeof loaderId !== 'string' || loaderId.length === 0) {
      throw new Error('CDP Page.getFrameTree returned no main-frame loaderId');
    }
    return loaderId;
  }

  async targetFacts(backendNodeId: number): Promise<ActionTargetFacts> {
    const session = await this.resolveSession();
    try {
      const facts = decodeTargetFacts(
        await callOnNode(session, backendNodeId, TARGET_FACTS_FUNCTION)
      );
      if (!facts.connected) {
        throw new BrowserActionError('stale_ref', 'That element is no longer on the page');
      }
      return facts;
    } finally {
      await session.send('Runtime.releaseObjectGroup', { objectGroup: ACTION_OBJECT_GROUP });
    }
  }

  async click(backendNodeId: number): Promise<void> {
    const session = await this.resolveSession();
    try {
      const { x, y } = await clickPoint(session, backendNodeId);
      // Playwright's "receives events" check: the press must land on the
      // element, not on an overlay covering it.
      const covering = await callOnNode(session, backendNodeId, HIT_TEST_FUNCTION, [x, y]);
      if (covering !== null) {
        throw new BrowserActionError(
          'element_not_actionable',
          `Another element covers it: ${String(covering)}`
        );
      }
      const mouse = { button: 'left', clickCount: 1, x, y } as const;
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await session.send('Input.dispatchMouseEvent', { ...mouse, type: 'mousePressed' });
      await session.send('Input.dispatchMouseEvent', { ...mouse, type: 'mouseReleased' });
    } finally {
      await session.send('Runtime.releaseObjectGroup', { objectGroup: ACTION_OBJECT_GROUP });
    }
  }

  async type(backendNodeId: number, text: string, submit: boolean): Promise<void> {
    const session = await this.resolveSession();
    try {
      const prepared = await callOnNode(session, backendNodeId, FILL_FUNCTION, [text]);
      if (prepared === 'needsinput') {
        if (text.length === 0) {
          await pressKey(session, DELETE);
        } else {
          await session.send('Input.insertText', { text });
        }
      } else if (prepared !== 'done') {
        throw new Error('The page did not prepare the field for input');
      }
      if (submit) {
        await pressKey(session, ENTER, '\r');
      }
    } finally {
      await session.send('Runtime.releaseObjectGroup', { objectGroup: ACTION_OBJECT_GROUP });
    }
  }

  async selectOptions(
    backendNodeId: number,
    values: readonly string[]
  ): Promise<readonly string[]> {
    const session = await this.resolveSession();
    try {
      const selected = await callOnNode(session, backendNodeId, SELECT_OPTIONS_FUNCTION, [values]);
      if (!(Array.isArray(selected) && selected.every((value) => typeof value === 'string'))) {
        throw new Error('The page did not report the selected options');
      }
      return selected;
    } finally {
      await session.send('Runtime.releaseObjectGroup', { objectGroup: ACTION_OBJECT_GROUP });
    }
  }
}

/**
 * Run one in-page function on a ref's node (BST-2324). A node CDP no longer
 * knows is a `stale_ref`; an exception the function throws is the model's to
 * read as `element_not_actionable`; anything else is the transport's own error.
 */
async function callOnNode(
  session: CdpSession,
  backendNodeId: number,
  functionDeclaration: string,
  args: readonly unknown[] = []
): Promise<unknown> {
  let objectId: string;
  try {
    const resolved = await session.send<{ readonly object?: { readonly objectId?: string } }>(
      'DOM.resolveNode',
      { backendNodeId, objectGroup: ACTION_OBJECT_GROUP }
    );
    if (typeof resolved?.object?.objectId !== 'string') {
      throw new Error('CDP DOM.resolveNode returned no object');
    }
    objectId = resolved.object.objectId;
  } catch (error) {
    if (error instanceof Error && STALE_NODE.test(error.message)) {
      throw new BrowserActionError('stale_ref', 'That element is no longer on the page');
    }
    throw error;
  }
  const called = await session.send<EvaluateResult>('Runtime.callFunctionOn', {
    arguments: args.map((value) => ({ value })),
    functionDeclaration,
    objectId,
    returnByValue: true,
  });
  if (called?.exceptionDetails) {
    const thrown =
      called.exceptionDetails.exception?.description ?? called.exceptionDetails.text ?? 'failed';
    // `Error: message\n    at …` → `message`.
    throw new BrowserActionError(
      'element_not_actionable',
      thrown.split('\n')[0]?.replace(/^\w*Error: /u, '') ?? thrown
    );
  }
  return called?.result?.value;
}

async function pressKey(
  session: CdpSession,
  key: typeof ENTER | typeof DELETE,
  text?: string
): Promise<void> {
  await session.send('Input.dispatchKeyEvent', {
    ...key,
    type: text === undefined ? 'rawKeyDown' : 'keyDown',
    ...(text === undefined ? {} : { text, unmodifiedText: text }),
  });
  await session.send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
}

/** The centre of the node's first visible box, in viewport CSS pixels. */
async function clickPoint(
  session: CdpSession,
  backendNodeId: number
): Promise<{ readonly x: number; readonly y: number }> {
  await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
  const { quads } = await session.send<ContentQuadsResult>('DOM.getContentQuads', {
    backendNodeId,
  });
  for (const quad of quads ?? []) {
    const xs = [0, 2, 4, 6].map((index) => quad[index] ?? Number.NaN);
    const ys = [1, 3, 5, 7].map((index) => quad[index] ?? Number.NaN);
    if (![...xs, ...ys].every(Number.isFinite)) {
      continue;
    }
    if (Math.max(...xs) - Math.min(...xs) >= 1 && Math.max(...ys) - Math.min(...ys) >= 1) {
      const centre = (values: readonly number[]) => values.reduce((sum, v) => sum + v, 0) / 4;
      return { x: centre(xs), y: centre(ys) };
    }
  }
  throw new BrowserActionError('element_not_actionable', 'That element is not visible');
}

function toClip(region: PaneRegion): Record<string, number> {
  return {
    height: region.height,
    scale: 1,
    width: region.width,
    x: region.x,
    y: region.y,
  };
}
