import {
  type ActionOutcome,
  createTabStripActions,
  createTestActionRegistry,
  defineContextAction,
} from '@brainstrike/context-actions';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentType, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionRegistryProvider } from '../../context-menu';
import { TabStrip } from '../tab-strip';
import type { TabStripContextMenu, TabStripItem } from '../types';

// happy-dom loads no Tailwind, so the scroller's `overflow-x-auto` never
// computes and auto-scroll's dev check dumps the whole element to stderr on
// every mount. Same stub as app-shell's thread-tab suites; the real
// registration runs in `tab-strip.browser.test.tsx` against real CSS.
vi.mock('@atlaskit/pragmatic-drag-and-drop-auto-scroll/element', () => ({
  autoScrollForElements: () => () => undefined,
}));

const renderCounts = new Map<string, number>();
const iconCache = new Map<string, ComponentType<{ className?: string }>>();

/** Per-tab icon whose render count reveals which TabStripTab re-rendered. */
function countingIcon(id: string): ComponentType<{ className?: string }> {
  const cached = iconCache.get(id);
  if (cached) {
    return cached;
  }
  function CountingIcon({ className }: { className?: string }): ReactElement {
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    return <svg className={className} data-icon={id} />;
  }
  iconCache.set(id, CountingIcon);
  return CountingIcon;
}

function makeItem(id: string, overrides: Partial<TabStripItem> = {}): TabStripItem {
  return {
    closable: true,
    icon: countingIcon(id),
    id,
    label: `Tab ${id}`,
    panelDomId: `panel-${id}`,
    tabDomId: `tab-${id}`,
    ...overrides,
  };
}

interface HarnessProps {
  /** Scroll-group tabs rendered before `initial` with `reorderable: false`. */
  readonly fixed?: readonly string[];
  readonly initial: readonly string[];
  readonly onActivateSpy?: (id: string) => void;
  readonly onCloseAll?: () => void;
  readonly onMenuOpenChange?: (open: boolean) => void;
  readonly pinned?: readonly string[];
  readonly reorderable?: boolean;
  readonly withMenu?: boolean;
}

function Harness({
  fixed = [],
  initial,
  onActivateSpy,
  onCloseAll,
  onMenuOpenChange,
  pinned = [],
  reorderable = true,
  withMenu = false,
}: HarnessProps): ReactElement {
  const [order, setOrder] = useState<readonly string[]>(initial);
  const [activeId, setActiveId] = useState<string | null>(initial[0] ?? null);
  const orderRef = useRef(order);
  useEffect(() => {
    orderRef.current = order;
  }, [order]);
  const items = useMemo(
    () => [
      ...fixed.map((id) => makeItem(id, { reorderable: false })),
      ...order.map((id) => makeItem(id)),
    ],
    [fixed, order]
  );
  const pinnedItems = useMemo(
    () => pinned.map((id) => makeItem(id, { closable: false })),
    [pinned]
  );
  const close = (id: string): void =>
    setOrder((current) => current.filter((candidate) => candidate !== id));
  const contextMenu = useMemo<TabStripContextMenu | undefined>(() => {
    if (!withMenu) {
      return;
    }
    return {
      getStripTarget: () => ({ kind: 'tab-strip', stripId: 'test' }),
      getTabTarget: (id) => ({
        id,
        kind: 'assistant-thread-tab',
        resourceId: 'r',
        title: `Tab ${id}`,
      }),
      localActions: [
        ...createTabStripActions({
          close: (id) => setOrder((current) => current.filter((candidate) => candidate !== id)),
          getId: (target) => target.id,
          getLabel: (target) => target.title,
          getOrderedIds: () => orderRef.current,
          idPrefix: 'test-tab',
          kind: 'assistant-thread-tab',
          noun: 'tab',
        }),
        defineContextAction({
          appliesTo: ['tab-strip'] as const,
          group: 'primary',
          id: 'test-strip.new',
          label: 'New Tab',
          run: (): Promise<ActionOutcome> => Promise.resolve({ ok: true }),
        }),
      ],
    };
  }, [withMenu]);
  return (
    <TabStrip
      activeId={activeId}
      aria-label="Test tabs"
      contextMenu={contextMenu}
      items={items}
      onActivate={(id) => {
        onActivateSpy?.(id);
        setActiveId(id);
      }}
      onClose={close}
      onCloseAll={onCloseAll}
      onMenuOpenChange={onMenuOpenChange}
      onReorder={reorderable ? setOrder : undefined}
      pinnedItems={pinnedItems}
      trailing={<button type="button">New</button>}
    />
  );
}

function renderStrip(props: HarnessProps) {
  const { registry } = createTestActionRegistry();
  return render(
    <ActionRegistryProvider registry={registry}>
      <Harness {...props} />
    </ActionRegistryProvider>
  );
}

const tab = (name: string): HTMLElement => screen.getByRole('tab', { name });
const tabNames = (): string[] =>
  within(screen.getByRole('tablist'))
    .getAllByRole('tab')
    .map((element) => element.textContent ?? '');

afterEach(() => {
  renderCounts.clear();
  vi.restoreAllMocks();
});

describe('TabStrip structure', () => {
  it('exposes one named horizontal tablist that owns only tabs, pinned first', () => {
    renderStrip({ initial: ['a', 'b'], pinned: ['p'] });
    const tablist = screen.getByRole('tablist', { name: 'Test tabs' });
    expect(tablist).toHaveAttribute('aria-orientation', 'horizontal');
    expect(tabNames()).toEqual(['Tab p', 'Tab a', 'Tab b']);
    expect(within(tablist).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'New' }).closest('[role="tablist"]')).toBeNull();
  });

  it('makes only the active tab a tab stop', () => {
    renderStrip({ initial: ['a', 'b', 'c'] });
    expect(tab('Tab a')).toHaveAttribute('tabindex', '0');
    expect(tab('Tab b')).toHaveAttribute('tabindex', '-1');
    expect(tab('Tab c')).toHaveAttribute('tabindex', '-1');
  });
});

describe('TabStrip keyboard (APG, manual activation)', () => {
  it('moves focus with arrows and activates only on Enter or Space', async () => {
    const user = userEvent.setup();
    const onActivateSpy = vi.fn();
    renderStrip({ initial: ['a', 'b', 'c'], onActivateSpy });
    tab('Tab a').focus();
    await user.keyboard('{ArrowRight}');
    expect(tab('Tab b')).toHaveFocus();
    expect(onActivateSpy).not.toHaveBeenCalled();
    expect(tab('Tab a')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(onActivateSpy).toHaveBeenLastCalledWith('b');
    await user.keyboard('{ArrowRight}');
    await user.keyboard(' ');
    expect(onActivateSpy).toHaveBeenLastCalledWith('c');
  });

  it('wraps and jumps with Home/End across the pinned and scroll groups', async () => {
    const user = userEvent.setup();
    renderStrip({ initial: ['a', 'b'], pinned: ['p'] });
    tab('Tab p').focus();
    await user.keyboard('{ArrowLeft}');
    expect(tab('Tab b')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(tab('Tab p')).toHaveFocus();
    await user.keyboard('{End}');
    expect(tab('Tab b')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tab('Tab p')).toHaveFocus();
  });

  it('leaves modified arrows to global chords', () => {
    renderStrip({ initial: ['a', 'b'] });
    tab('Tab a').focus();
    const notPrevented = fireEvent.keyDown(tab('Tab a'), { ctrlKey: true, key: 'ArrowRight' });
    expect(notPrevented).toBe(true);
    expect(tab('Tab a')).toHaveFocus();
  });

  it('closes the focused tab with Delete and focuses the next tab', async () => {
    renderStrip({ initial: ['a', 'b', 'c'] });
    tab('Tab b').focus();
    fireEvent.keyDown(tab('Tab b'), { key: 'Delete' });
    expect(tabNames()).toEqual(['Tab a', 'Tab c']);
    await waitFor(() => expect(tab('Tab c')).toHaveFocus());
  });

  it('focuses the previous tab when the last tab closes', async () => {
    renderStrip({ initial: ['a', 'b'] });
    tab('Tab b').focus();
    fireEvent.keyDown(tab('Tab b'), { key: 'Delete' });
    await waitFor(() => expect(tab('Tab a')).toHaveFocus());
  });

  it('focuses the strip trailing control when the only tab closes', async () => {
    renderStrip({ initial: ['a'] });
    tab('Tab a').focus();
    fireEvent.keyDown(tab('Tab a'), { key: 'Delete' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'New' })).toHaveFocus());
  });

  it('focuses the tablist when the only tab closes and the strip has no trailing controls', async () => {
    function Lone(): ReactElement {
      const [ids, setIds] = useState<readonly string[]>(['a']);
      const items = useMemo(() => ids.map((id) => makeItem(id)), [ids]);
      return (
        <TabStrip
          activeId={ids[0] ?? null}
          aria-label="Lone"
          items={items}
          onActivate={() => undefined}
          onClose={(id) => setIds((current) => current.filter((candidate) => candidate !== id))}
        />
      );
    }
    render(<Lone />);
    tab('Tab a').focus();
    fireEvent.keyDown(tab('Tab a'), { key: 'Delete' });
    await waitFor(() => expect(screen.getByRole('tablist', { name: 'Lone' })).toHaveFocus());
  });

  it('never closes a non-closable tab', () => {
    renderStrip({ initial: ['a'], pinned: ['p'] });
    tab('Tab p').focus();
    fireEvent.keyDown(tab('Tab p'), { key: 'Delete' });
    expect(tabNames()).toEqual(['Tab p', 'Tab a']);
  });

  it('reorders with Alt+Shift+Arrow, keeps focus on the moved tab and announces it', async () => {
    renderStrip({ initial: ['a', 'b', 'c'] });
    tab('Tab a').focus();
    fireEvent.keyDown(tab('Tab a'), { altKey: true, key: 'ArrowRight', shiftKey: true });
    expect(tabNames()).toEqual(['Tab b', 'Tab a', 'Tab c']);
    await waitFor(() => expect(tab('Tab a')).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('Tab a moved to position 2 of 3');
  });

  it('never reorders pinned tabs or strips without onReorder', () => {
    renderStrip({ initial: ['a', 'b'], pinned: ['p'] });
    fireEvent.keyDown(tab('Tab p'), { altKey: true, key: 'ArrowRight', shiftKey: true });
    expect(tabNames()).toEqual(['Tab p', 'Tab a', 'Tab b']);
  });

  it('never moves a non-reorderable scroll tab and reports only reorderable ids', async () => {
    renderStrip({ fixed: ['x'], initial: ['a', 'b'] });
    expect(tab('Tab x').closest('[data-slot="tab-shell"]')).not.toHaveAttribute('data-reorderable');
    expect(tab('Tab a').closest('[data-slot="tab-shell"]')).toHaveAttribute(
      'data-reorderable',
      'true'
    );
    fireEvent.keyDown(tab('Tab x'), { altKey: true, key: 'ArrowRight', shiftKey: true });
    expect(tabNames()).toEqual(['Tab x', 'Tab a', 'Tab b']);
    expect(screen.getByRole('status')).toHaveTextContent('');
    // Moving "a" left is at the edge of the REORDERABLE run: nothing to swap with.
    fireEvent.keyDown(tab('Tab a'), { altKey: true, key: 'ArrowLeft', shiftKey: true });
    expect(tabNames()).toEqual(['Tab x', 'Tab a', 'Tab b']);
    fireEvent.keyDown(tab('Tab a'), { altKey: true, key: 'ArrowRight', shiftKey: true });
    expect(tabNames()).toEqual(['Tab x', 'Tab b', 'Tab a']);
    expect(screen.getByRole('status')).toHaveTextContent('Tab a moved to position 2 of 2');
  });

  it('does not reorder when the strip has no onReorder', () => {
    renderStrip({ initial: ['a', 'b'], reorderable: false });
    fireEvent.keyDown(tab('Tab a'), { altKey: true, key: 'ArrowRight', shiftKey: true });
    expect(tabNames()).toEqual(['Tab a', 'Tab b']);
  });
});

describe('TabStrip context menu', () => {
  it('opens the tab menu on right-click and runs the action against that tab', async () => {
    const user = userEvent.setup();
    renderStrip({ initial: ['a', 'b', 'c'], withMenu: true });
    fireEvent.contextMenu(tab('Tab b'));
    await user.click(await screen.findByRole('menuitem', { name: 'Close' }));
    await waitFor(() => expect(tabNames()).toEqual(['Tab a', 'Tab c']));
  });

  it('opens the strip menu from the empty background', async () => {
    renderStrip({ initial: ['a'], withMenu: true });
    fireEvent.contextMenu(screen.getByRole('tablist'));
    expect(await screen.findByRole('menuitem', { name: 'New Tab' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Close' })).toBeNull();
  });

  it('opens the focused tab menu with Shift+F10 and returns focus to that tab', async () => {
    const user = userEvent.setup();
    renderStrip({ initial: ['a', 'b'], withMenu: true });
    tab('Tab b').focus();
    fireEvent.keyDown(tab('Tab b'), { key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menuitem', { name: 'Close' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(tab('Tab b')).toHaveFocus());
  });

  it('opens from the ContextMenu key on keyup, where Windows Chromium raises its native menu', async () => {
    renderStrip({ initial: ['a', 'b'], withMenu: true });
    tab('Tab b').focus();
    const keydownNotPrevented = fireEvent.keyDown(tab('Tab b'), { key: 'ContextMenu' });
    expect(keydownNotPrevented).toBe(false);
    expect(screen.queryByRole('menuitem', { name: 'Close' })).toBeNull();
    const keyupNotPrevented = fireEvent.keyUp(tab('Tab b'), { key: 'ContextMenu' });
    expect(keyupNotPrevented).toBe(false);
    expect(await screen.findByRole('menuitem', { name: 'Close' })).toBeInTheDocument();
  });

  it('never drops focus to body when an empty strip with no controls closes its menu', async () => {
    const user = userEvent.setup();
    const { registry } = createTestActionRegistry();
    render(
      <ActionRegistryProvider registry={registry}>
        <TabStrip
          activeId={null}
          aria-label="Empty"
          contextMenu={{
            getStripTarget: () => ({ kind: 'tab-strip', stripId: 'empty' }),
            getTabTarget: () => null,
            localActions: [
              defineContextAction({
                appliesTo: ['tab-strip'] as const,
                group: 'primary',
                id: 'empty-strip.new',
                label: 'New Tab',
                run: (): Promise<ActionOutcome> => Promise.resolve({ ok: true }),
              }),
            ],
          }}
          items={[]}
          onActivate={() => undefined}
        />
      </ActionRegistryProvider>
    );
    fireEvent.contextMenu(screen.getByRole('tablist'));
    expect(await screen.findByRole('menuitem', { name: 'New Tab' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('tablist', { name: 'Empty' })).toHaveFocus());
  });

  it('advertises a popup menu on tabs only when the strip has one', () => {
    const view = renderStrip({ initial: ['a'] });
    expect(tab('Tab a')).not.toHaveAttribute('aria-haspopup');
    view.unmount();
    renderStrip({ initial: ['a'], withMenu: true });
    expect(tab('Tab a')).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('reports context-menu and All-tabs menu open changes to the host', async () => {
    const user = userEvent.setup();
    const onMenuOpenChange = vi.fn();
    renderStrip({ initial: ['a', 'b'], onMenuOpenChange, withMenu: true });
    fireEvent.contextMenu(tab('Tab b'));
    expect(await screen.findByRole('menuitem', { name: 'Close' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(onMenuOpenChange.mock.calls).toEqual([[true], [false]]);
    onMenuOpenChange.mockClear();
    await user.click(screen.getByRole('button', { name: 'All tabs' }));
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(2);
    expect(onMenuOpenChange.mock.calls).toEqual([[true]]);
  });
});

describe('TabStrip All-tabs menu', () => {
  it('lists every tab and activates the chosen one', async () => {
    const user = userEvent.setup();
    renderStrip({ initial: ['a', 'b'], pinned: ['p'] });
    await user.click(screen.getByRole('button', { name: 'All tabs' }));
    const options = await screen.findAllByRole('menuitemradio');
    expect(options.map((option) => option.textContent)).toEqual(['Tab p', 'Tab a', 'Tab b']);
    await user.click(screen.getByRole('menuitemradio', { name: 'Tab b' }));
    await waitFor(() => expect(tab('Tab b')).toHaveAttribute('aria-selected', 'true'));
  });

  it('offers Close All only when the strip supports it', async () => {
    const user = userEvent.setup();
    const onCloseAll = vi.fn();
    renderStrip({ initial: ['a'], onCloseAll });
    await user.click(screen.getByRole('button', { name: 'All tabs' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Close All' }));
    expect(onCloseAll).toHaveBeenCalledTimes(1);
  });
});

describe('TabStrip reveal', () => {
  it('reveals on keyboard focus and activation but never on pointer focus', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      renderStrip({ initial: ['a', 'b', 'c'] });
      // Mount reveal of the active tab jumps rather than animating.
      expect(scrollIntoView).toHaveBeenLastCalledWith(
        expect.objectContaining({ behavior: 'auto' })
      );
      scrollIntoView.mockClear();

      fireEvent.pointerDown(tab('Tab b'));
      tab('Tab b').focus();
      expect(scrollIntoView).not.toHaveBeenCalled();

      tab('Tab c').focus();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      // A press that never produces focus (the mouse-only close button, or
      // Safari buttons) must not leave the next keyboard focus unrevealed.
      scrollIntoView.mockClear();
      fireEvent.pointerDown(tab('Tab a'));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      tab('Tab a').focus();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });
});

describe('TabStrip render isolation', () => {
  it('re-renders only the previously and newly active tabs on selection', async () => {
    const user = userEvent.setup();
    renderStrip({ initial: ['a', 'b', 'c'] });
    const before = new Map(renderCounts);
    await user.click(tab('Tab c'));
    await waitFor(() => expect(tab('Tab c')).toHaveAttribute('aria-selected', 'true'));
    const delta = (id: string): number => (renderCounts.get(id) ?? 0) - (before.get(id) ?? 0);
    expect(delta('b')).toBe(0);
    expect(delta('a')).toBeGreaterThan(0);
    expect(delta('c')).toBeGreaterThan(0);
  });
});

describe('TabStrip containment', () => {
  it('replaces a crashing strip with an inline retry row', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Boom(): ReactElement {
      throw new Error('mark exploded');
    }
    render(
      <TabStrip
        activeId="x"
        aria-label="Broken"
        items={[makeItem('x', { mark: <Boom /> })]}
        onActivate={() => undefined}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Tabs unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
