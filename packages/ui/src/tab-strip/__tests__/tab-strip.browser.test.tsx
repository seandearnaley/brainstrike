import './tab-strip.browser.css';
import { createTabStripActions, createTestActionRegistry } from '@brainstrike/context-actions';
import { render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ActionRegistryProvider } from '../../context-menu';
import { TabStrip } from '../tab-strip';
import type { TabStripItem } from '../types';

function items(ids: readonly string[]): TabStripItem[] {
  return ids.map((id) => ({
    closable: true,
    id,
    label: `Document ${id}`,
    panelDomId: `panel-${id}`,
    tabDomId: `tab-${id}`,
  }));
}

function Harness({ width = 800 }: { readonly width?: number }): ReactElement {
  const [order, setOrder] = useState<readonly string[]>(['a', 'b', 'c']);
  const [activeId, setActiveId] = useState<string | null>('a');
  const orderRef = useRef(order);
  useEffect(() => {
    orderRef.current = order;
  }, [order]);
  const localActions = useMemo(
    () =>
      createTabStripActions({
        close: (id) => setOrder((current) => current.filter((candidate) => candidate !== id)),
        getId: (target) => target.id,
        getLabel: (target) => target.title,
        getOrderedIds: () => orderRef.current,
        idPrefix: 'browser-tab',
        kind: 'assistant-thread-tab',
        noun: 'tab',
      }),
    []
  );
  return (
    <div style={{ width }}>
      <TabStrip
        activeId={activeId}
        aria-label="Documents"
        contextMenu={{
          getTabTarget: (id) => ({
            id,
            kind: 'assistant-thread-tab',
            resourceId: 'r',
            title: `Document ${id}`,
          }),
          localActions,
        }}
        items={items(order)}
        onActivate={setActiveId}
        onClose={(id) => setOrder((current) => current.filter((candidate) => candidate !== id))}
        onReorder={setOrder}
        testId="strip"
      />
      <p data-testid="order">{order.join(',')}</p>
    </div>
  );
}

function mount(width?: number) {
  const { registry } = createTestActionRegistry();
  return render(
    <ActionRegistryProvider registry={registry}>
      <Harness {...(width === undefined ? {} : { width })} />
    </ActionRegistryProvider>
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

test('paints the spec §5 geometry with real Tailwind', () => {
  mount();
  const strip = screen.getByTestId('strip');
  const shell = screen
    .getByRole('tab', { name: 'Document a' })
    .closest('[data-slot="tab-shell"]') as HTMLElement;
  const trigger = screen.getByRole('tab', { name: 'Document a' });
  expect(strip.getBoundingClientRect().height).toBe(36);
  expect(shell.getBoundingClientRect().height).toBe(28);
  expect(getComputedStyle(shell).borderTopLeftRadius).toBe('6px');
  expect(getComputedStyle(trigger).fontSize).toBe('12px');
  expect(getComputedStyle(trigger).fontWeight).toBe('500');
  const close = shell.querySelector('[data-slot="tab-close"]') as HTMLElement;
  expect(close.getBoundingClientRect().width).toBe(20);
  const [first, second] = [...strip.querySelectorAll<HTMLElement>('[data-slot="tab-shell"]')];
  if (!(first && second)) {
    throw new Error('expected at least two tab shells');
  }
  expect(second.getBoundingClientRect().left - first.getBoundingClientRect().right).toBe(4);
});

// Tailwind v4 can emit a variant rule after `focus-visible:` rules, which let the
// segmented Tabs' 1px selected ring paint over its 2px focus ring (BST-1841).
// The shell's focus ring is a `has-[...]` variant beside a plain `ring-1`
// selected ring; this proves the focus ring wins on the focused selected tab.
test('paints the 2px inset focus ring over the 1px selected ring on the focused active tab', async () => {
  mount();
  const active = screen.getByRole('tab', { name: 'Document a' });
  const shell = active.closest('[data-slot="tab-shell"]') as HTMLElement;
  expect(active).toHaveAttribute('aria-selected', 'true');
  expect(getComputedStyle(shell).boxShadow).toContain('0px 0px 0px 1px');
  expect(getComputedStyle(shell).boxShadow).not.toContain('inset');

  screen.getByRole('tab', { name: 'Document b' }).focus();
  await userEvent.keyboard('{ArrowLeft}');
  expect(active).toHaveFocus();
  expect(active.matches(':focus-visible')).toBe(true);
  // The shell transitions box-shadow for 150ms; read the settled value.
  await waitFor(() => {
    const boxShadow = getComputedStyle(shell).boxShadow;
    expect(boxShadow).toContain('0px 0px 0px 2px inset');
    expect(boxShadow).not.toContain('0px 0px 0px 1px');
  });
});

test('passes axe ARIA structure rules (defect 1 regression guard, D9)', async () => {
  mount();
  const result = await axe.run(screen.getByTestId('strip'), {
    runOnly: {
      type: 'rule',
      values: ['aria-required-children', 'nested-interactive', 'aria-hidden-focus'],
    },
  });
  expect(result.violations).toEqual([]);
});

test('opens the tab menu from the keyboard, anchored at the tab', async () => {
  mount();
  const tab = screen.getByRole('tab', { name: 'Document b' });
  tab.focus();
  await userEvent.keyboard('{Shift>}{F10}{/Shift}');
  const menu = await screen.findByRole('menu');
  const tabRect = tab.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  expect(Math.abs(menuRect.left - tabRect.left)).toBeLessThan(16);
  expect(menuRect.top).toBeGreaterThanOrEqual(tabRect.bottom - 1);
  expect(screen.getAllByRole('menu')).toHaveLength(1);
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(tab).toHaveFocus());
});

test('reorders by native drag and drop onto the left edge of a tab', async () => {
  mount();
  const source = screen.getByRole('tab', { name: 'Document c' });
  const target = screen.getByRole('tab', { name: 'Document a' });
  await userEvent.dragAndDrop(source, target, { targetPosition: { x: 4, y: 10 } });
  await waitFor(() => expect(screen.getByTestId('order')).toHaveTextContent('c,a,b'));
});

test('maps wheel input to horizontal scroll when tabs overflow', async () => {
  mount(220);
  const scroller = screen
    .getByTestId('strip')
    .querySelector('[data-group="scroll"]') as HTMLElement;
  await waitFor(() => expect(scroller.dataset['overflowEnd']).toBe('true'));
  scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));
  expect(scroller.scrollLeft).toBeGreaterThan(0);
  await waitFor(() => expect(scroller.dataset['overflowStart']).toBe('true'));
});
