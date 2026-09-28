import * as TabsPrimitive from '@radix-ui/react-tabs';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, Suspense, startTransition, use, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../src/tabs';

function TwoTabs({ size }: { readonly size?: 'md' | 'sm' }): ReactElement {
  return (
    <Tabs defaultValue="one">
      <TabsList aria-label="Views" {...(size ? { size } : {})}>
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
      </TabsList>
      <TabsContent value="one">One content</TabsContent>
      <TabsContent value="two">Two content</TabsContent>
    </Tabs>
  );
}

/**
 * Stateful panel body. A remount replaces the element and drops its typed
 * value, so element identity plus value proves the panel never remounted.
 */
function Field({ label }: { readonly label: string }): ReactElement {
  return <input aria-label={label} defaultValue="" />;
}

const TRIGGER_WEIGHT_CLASS = /(^|:)font-(thin|extralight|light|normal|medium|semibold|bold)$/;

describe('Tabs', () => {
  it('renders Tabs with its children', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Tab 1 Content</TabsContent>
        <TabsContent value="tab2">Tab 2 Content</TabsContent>
      </Tabs>
    );

    expect(screen.getByText('Tab 1')).toBeInTheDocument();
    expect(screen.getByText('Tab 2')).toBeInTheDocument();
    expect(screen.getByText('Tab 1 Content')).toBeInTheDocument();
    // Without keepMounted an inactive panel renders no children (Radix default).
    expect(screen.queryByText('Tab 2 Content')).not.toBeInTheDocument();
  });

  it('marks every part with its data-slot', () => {
    const { container } = render(<TwoTabs />);

    expect(container.firstElementChild).toHaveAttribute('data-slot', 'tabs');
    expect(screen.getByRole('tablist')).toHaveAttribute('data-slot', 'tabs-list');
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('data-slot', 'tabs-trigger');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-slot', 'tabs-content');
  });

  it('renders TabsList with custom className', () => {
    render(
      <Tabs>
        <TabsList className="custom-class">
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
        </TabsList>
      </Tabs>
    );

    expect(screen.getByRole('tablist')).toHaveClass('custom-class');
  });

  it('renders TabsTrigger with custom className', () => {
    render(
      <Tabs>
        <TabsList>
          <TabsTrigger className="custom-trigger" value="tab1">
            Tab 1
          </TabsTrigger>
        </TabsList>
      </Tabs>
    );

    expect(screen.getByRole('tab')).toHaveClass('custom-trigger');
  });

  it('renders TabsContent with custom className', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent className="custom-content" value="tab1">
          Content
        </TabsContent>
      </Tabs>
    );

    expect(screen.getByText('Content')).toHaveClass('custom-content');
  });

  it('passes additional props to TabsList, TabsTrigger and TabsContent', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList data-testid="tabs-list">
          <TabsTrigger data-testid="tabs-trigger" value="tab1">
            Tab 1
          </TabsTrigger>
        </TabsList>
        <TabsContent data-testid="tabs-content" value="tab1">
          Content
        </TabsContent>
      </Tabs>
    );

    expect(screen.getByTestId('tabs-list')).toBeInTheDocument();
    expect(screen.getByTestId('tabs-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('tabs-content')).toBeInTheDocument();
  });

  it('uses the shared tab motion token instead of transition-all', () => {
    render(<TwoTabs />);

    const trigger = screen.getByRole('tab', { name: 'One' });
    expect(trigger).toHaveClass(
      'transition-[color,background-color,box-shadow,opacity]',
      'duration-150',
      'motion-reduce:transition-none'
    );
    expect(trigger.className).not.toContain('transition-all');
  });

  describe('sizes', () => {
    it('sm is the panel-header switcher: 28px track, 24px trigger, 12px medium label', () => {
      render(<TwoTabs size="sm" />);

      const list = screen.getByRole('tablist');
      expect(list).toHaveAttribute('data-size', 'sm');
      expect(list).toHaveClass('h-7', 'rounded-md', 'bg-muted', 'p-0.5');
      for (const trigger of screen.getAllByRole('tab')) {
        expect(trigger).toHaveAttribute('data-size', 'sm');
        expect(trigger).toHaveClass(
          'h-6',
          'rounded-[calc(var(--radius-md)-2px)]',
          'px-2',
          'text-xs',
          'font-medium'
        );
      }
    });

    it('md is the full-page switcher and the default: 36px track, 32px trigger, 14px label', () => {
      render(<TwoTabs />);

      const list = screen.getByRole('tablist');
      expect(list).toHaveAttribute('data-size', 'md');
      expect(list).toHaveClass('h-9', 'rounded-md', 'bg-muted', 'p-0.5');
      for (const trigger of screen.getAllByRole('tab')) {
        expect(trigger).toHaveAttribute('data-size', 'md');
        expect(trigger).toHaveClass(
          'h-8',
          'rounded-[calc(var(--radius-md)-2px)]',
          'px-4',
          'text-sm',
          'font-medium'
        );
      }
    });

    it.each(['sm', 'md'] as const)('%s changes colour, never weight, between states', (size) => {
      render(<TwoTabs size={size} />);

      for (const trigger of screen.getAllByRole('tab')) {
        const weightClasses = [...trigger.classList].filter((name) =>
          TRIGGER_WEIGHT_CLASS.test(name)
        );
        // One unconditional weight, so selecting a tab never changes its width.
        expect(weightClasses).toEqual(['font-medium']);
      }
    });
  });

  describe('states', () => {
    it('paints the selected trigger as the raised surface and idle triggers muted', () => {
      render(<TwoTabs size="sm" />);

      const trigger = screen.getByRole('tab', { name: 'One' });
      expect(trigger).toHaveClass(
        'text-muted-foreground',
        'hover:text-foreground',
        'data-[state=active]:bg-background',
        'data-[state=active]:text-foreground',
        'data-[state=active]:shadow-xs',
        'data-[state=active]:ring-1',
        'data-[state=active]:ring-border/70'
      );
    });

    it('draws an inset focus ring that also outranks the selected ring', () => {
      render(<TwoTabs size="sm" />);

      const trigger = screen.getByRole('tab', { name: 'One' });
      expect(trigger).toHaveClass(
        'outline-hidden',
        'focus-visible:ring-2',
        'focus-visible:ring-ring',
        'focus-visible:ring-inset',
        // `data-*` variants sort after `focus-visible` in Tailwind v4, so the
        // selected ring would otherwise repaint a focused active trigger.
        'focus-visible:data-[state=active]:ring-2',
        'focus-visible:data-[state=active]:ring-ring'
      );
    });
  });

  describe('activation', () => {
    it('activates manually by default: arrows move focus, Enter and Space select', async () => {
      const user = userEvent.setup();
      render(<TwoTabs />);

      const one = screen.getByRole('tab', { name: 'One' });
      const two = screen.getByRole('tab', { name: 'Two' });
      one.focus();
      await user.keyboard('{ArrowRight}');

      expect(two).toHaveFocus();
      expect(two).toHaveAttribute('aria-selected', 'false');
      expect(screen.getByText('One content')).toBeVisible();

      await user.keyboard('{Enter}');
      expect(two).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('Two content')).toBeVisible();

      await user.keyboard('{ArrowLeft}');
      expect(one).toHaveFocus();
      expect(one).toHaveAttribute('aria-selected', 'false');
      await user.keyboard(' ');
      expect(one).toHaveAttribute('aria-selected', 'true');
    });

    it('keeps automatic activation available as an explicit override', async () => {
      const user = userEvent.setup();
      render(
        <Tabs activationMode="automatic" defaultValue="one">
          <TabsList>
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two">Two</TabsTrigger>
          </TabsList>
        </Tabs>
      );

      screen.getByRole('tab', { name: 'One' }).focus();
      await user.keyboard('{ArrowRight}');

      expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
    });

    it('reports changes to a controlled owner without selecting on its own', () => {
      const onValueChange = vi.fn();
      render(
        <Tabs onValueChange={onValueChange} value="one">
          <TabsList>
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two">Two</TabsTrigger>
          </TabsList>
        </Tabs>
      );

      fireEvent.mouseDown(screen.getByRole('tab', { name: 'Two' }), { button: 0 });

      expect(onValueChange).toHaveBeenCalledExactlyOnceWith('two');
      expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('leaves the native context menu alone: fixed switchers have no menu', () => {
    render(<TwoTabs size="sm" />);

    const notPrevented = fireEvent.contextMenu(screen.getByRole('tab', { name: 'One' }));

    expect(notPrevented).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  describe('TabsContent keepMounted', () => {
    function KeepMountedTabs(): ReactElement {
      return (
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two">Two</TabsTrigger>
          </TabsList>
          <TabsContent data-testid="panel-one" value="one">
            One content
          </TabsContent>
          <TabsContent data-testid="panel-two" keepMounted value="two">
            <Field label="Two field" />
          </TabsContent>
        </Tabs>
      );
    }

    it('does not mount before first activation', () => {
      render(<KeepMountedTabs />);

      expect(
        screen.queryByRole('textbox', { hidden: true, name: 'Two field' })
      ).not.toBeInTheDocument();
      expect(screen.getByTestId('panel-two')).not.toBeVisible();
    });

    it('mounts visible on activation, then stays mounted but hidden, never remounting', async () => {
      const user = userEvent.setup();
      render(<KeepMountedTabs />);

      await user.click(screen.getByRole('tab', { name: 'Two' }));
      const field = screen.getByRole('textbox', { name: 'Two field' });
      expect(field).toBeVisible();
      expect(screen.getByTestId('panel-two')).toHaveAttribute('data-state', 'active');
      await user.type(field, 'kept');

      await user.click(screen.getByRole('tab', { name: 'One' }));
      expect(screen.getByTestId('panel-two')).toHaveAttribute('hidden');
      expect(screen.getByTestId('panel-two')).toHaveAttribute('data-state', 'inactive');
      expect(field).toBeInTheDocument();
      expect(field).not.toBeVisible();

      await user.click(screen.getByRole('tab', { name: 'Two' }));
      expect(screen.getByRole('textbox', { name: 'Two field' })).toBe(field);
      expect(field).toHaveValue('kept');
      expect(field).toBeVisible();
    });

    it('latches from a controlled value, including an owner that starts on the panel', async () => {
      const user = userEvent.setup();
      function Controlled({ value }: { readonly value: string }): ReactElement {
        return (
          <Tabs value={value}>
            <TabsList>
              <TabsTrigger value="one">One</TabsTrigger>
              <TabsTrigger value="two">Two</TabsTrigger>
            </TabsList>
            <TabsContent data-testid="panel-two" keepMounted value="two">
              <Field label="Two field" />
            </TabsContent>
          </Tabs>
        );
      }
      const view = render(<Controlled value="two" />);
      const field = screen.getByRole('textbox', { name: 'Two field' });
      expect(field).toBeVisible();
      await user.type(field, 'kept');

      view.rerender(<Controlled value="one" />);
      expect(field).toBeInTheDocument();
      expect(field).not.toBeVisible();

      view.rerender(<Controlled value="two" />);
      expect(screen.getByRole('textbox', { name: 'Two field' })).toBe(field);
      expect(field).toHaveValue('kept');
    });

    it('pre-mounts hidden with forceMount, so a preloaded panel keeps its state', async () => {
      const user = userEvent.setup();
      render(
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two">Two</TabsTrigger>
          </TabsList>
          <TabsContent data-testid="panel-two" forceMount keepMounted value="two">
            <Field label="Two field" />
          </TabsContent>
        </Tabs>
      );

      // `hidden: true`: the field is mounted inside a hidden panel.
      const field = screen.getByRole('textbox', { hidden: true, name: 'Two field' });
      expect(field).not.toBeVisible();
      expect(screen.getByTestId('panel-two')).toHaveAttribute('hidden');

      await user.click(screen.getByRole('tab', { name: 'Two' }));
      expect(screen.getByRole('textbox', { name: 'Two field' })).toBe(field);
      expect(field).toBeVisible();
    });

    it('unmounts an inactive panel without keepMounted (Radix default)', async () => {
      const user = userEvent.setup();
      render(
        <Tabs defaultValue="two">
          <TabsList>
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two">Two</TabsTrigger>
          </TabsList>
          <TabsContent value="two">
            <Field label="Two field" />
          </TabsContent>
        </Tabs>
      );
      const field = screen.getByRole('textbox', { name: 'Two field' });

      await user.click(screen.getByRole('tab', { name: 'One' }));
      expect(
        screen.queryByRole('textbox', { hidden: true, name: 'Two field' })
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole('tab', { name: 'Two' }));
      expect(screen.getByRole('textbox', { name: 'Two field' })).not.toBe(field);
    });

    it('refuses to render under a bare Radix root, where it cannot see the active value', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(() =>
        render(
          <TabsPrimitive.Root value="two">
            <TabsContent keepMounted value="two">
              Two content
            </TabsContent>
          </TabsPrimitive.Root>
        )
      ).toThrow('TabsContent must be rendered inside @brainstrike/ui Tabs');
      consoleError.mockRestore();
    });
  });

  describe('switching in a transition', () => {
    /**
     * Radix `Presence` flips an incoming panel to present in a layout effect,
     * which is a SYNC update: the panel's children would render after the
     * transition commits, blocking, and a suspension there would fall back.
     * `TabsContent` renders its children in the switch's own render instead.
     */
    it.each([
      ['keepMounted', true],
      ['default', false],
    ] as const)(
      'renders an incoming %s panel inside the transition',
      async (_label, keepMounted) => {
        let resolveTwo: () => void = () => undefined;
        const twoReady = new Promise<void>((resolve) => {
          resolveTwo = resolve;
        });
        function SlowTwo(): ReactElement {
          use(twoReady);
          return <div>Two content</div>;
        }
        let switchTo: (value: string) => void = () => undefined;
        function Switcher(): ReactElement {
          const [value, setValue] = useState('one');
          switchTo = (next) => {
            startTransition(() => {
              setValue(next);
            });
          };
          return (
            <Tabs value={value}>
              <TabsList>
                <TabsTrigger value="one">One</TabsTrigger>
                <TabsTrigger value="two">Two</TabsTrigger>
              </TabsList>
              <TabsContent value="one">One content</TabsContent>
              <TabsContent keepMounted={keepMounted} value="two">
                <SlowTwo />
              </TabsContent>
            </Tabs>
          );
        }
        render(
          <Suspense fallback={<div>Fallback</div>}>
            <Switcher />
          </Suspense>
        );

        // Awaited: React only retries a suspended render that `act` is awaiting.
        await act(async () => {
          switchTo('two');
        });

        // The suspended transition keeps the committed view instead of falling back.
        expect(screen.getByText('One content')).toBeVisible();
        expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.queryByText('Fallback')).not.toBeInTheDocument();

        await act(async () => {
          resolveTwo();
          await twoReady;
        });

        expect(await screen.findByText('Two content')).toBeVisible();
        expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
      }
    );
  });
});
