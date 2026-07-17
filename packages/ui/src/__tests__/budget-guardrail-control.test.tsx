import '@testing-library/jest-dom/vitest';
import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  type BudgetGuardrailContextValue,
  BudgetGuardrailProvider,
  useBudgetGuardrailContext,
} from '../assistant-ui-panel/budget-guardrail-context';
import {
  BudgetGuardrailControl,
  useBudgetSendGate,
} from '../assistant-ui-panel/budget-guardrail-control';

function makeContext(
  overrides: Partial<BudgetGuardrailContextValue> = {}
): BudgetGuardrailContextValue {
  return {
    overridden: false,
    override: vi.fn(),
    status: {
      capUsd: 10,
      estimatedUsd: 1,
      overCap: false,
      spentUsd: 3,
      unpricedModelCount: 0,
    },
    ...overrides,
  };
}

function GateProbe() {
  const blocked = useBudgetSendGate();
  return <output data-testid="gate-probe">{blocked ? 'blocked' : 'open'}</output>;
}

describe('BudgetGuardrailControl', () => {
  it('renders nothing without a provider value (no cap configured / no capability)', () => {
    const { container } = render(
      <BudgetGuardrailProvider value={null}>
        <BudgetGuardrailControl />
      </BudgetGuardrailProvider>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the last-24h burn-down chip with spent-of-cap totals', () => {
    render(
      <BudgetGuardrailProvider value={makeContext()}>
        <BudgetGuardrailControl />
      </BudgetGuardrailProvider>
    );
    const chip = screen.getByTestId('budget-guardrail-chip');
    // spentUsd + estimatedUsd of capUsd, labeled "last 24h" (never "today").
    expect(chip).toHaveTextContent('Last 24h');
    expect(chip).toHaveTextContent('$4.00 of $10.00');
    expect(screen.queryByTestId('budget-guardrail-blocked')).not.toBeInTheDocument();
  });

  it('marks unpriced models explicitly instead of folding them into the total', () => {
    render(
      <BudgetGuardrailProvider
        value={makeContext({
          status: {
            capUsd: 10,
            estimatedUsd: 0,
            overCap: false,
            spentUsd: 2,
            unpricedModelCount: 2,
          },
        })}
      >
        <BudgetGuardrailControl />
      </BudgetGuardrailProvider>
    );
    expect(screen.getByTestId('budget-guardrail-unpriced')).toHaveTextContent('+2 unpriced models');
  });

  it('over cap without override: blocks sending and shows the notice with Send anyway', async () => {
    const override = vi.fn();
    const user = userEvent.setup();
    render(
      <BudgetGuardrailProvider
        value={makeContext({
          override,
          status: {
            capUsd: 10,
            estimatedUsd: 2,
            overCap: true,
            spentUsd: 9,
            unpricedModelCount: 0,
          },
        })}
      >
        <BudgetGuardrailControl />
        <GateProbe />
      </BudgetGuardrailProvider>
    );

    expect(screen.getByTestId('gate-probe')).toHaveTextContent('blocked');
    const notice = screen.getByTestId('budget-guardrail-blocked');
    expect(notice).toHaveTextContent('Last-24h budget cap reached — $11.00 of $10.00');

    await user.click(screen.getByRole('button', { name: /send anyway/i }));
    expect(override).toHaveBeenCalledTimes(1);
  });

  it('over cap with the session override active: sending is open and the override is visible', () => {
    render(
      <BudgetGuardrailProvider
        value={makeContext({
          overridden: true,
          status: {
            capUsd: 10,
            estimatedUsd: 2,
            overCap: true,
            spentUsd: 9,
            unpricedModelCount: 0,
          },
        })}
      >
        <BudgetGuardrailControl />
        <GateProbe />
      </BudgetGuardrailProvider>
    );

    expect(screen.getByTestId('gate-probe')).toHaveTextContent('open');
    expect(screen.queryByTestId('budget-guardrail-blocked')).not.toBeInTheDocument();
    // Never a silent allow: the active override is stated next to the chip.
    expect(screen.getByTestId('budget-guardrail-overridden')).toHaveTextContent(
      /overridden for this session/i
    );
  });

  it('useBudgetSendGate is open when no context is provided', () => {
    render(
      <BudgetGuardrailProvider value={null}>
        <GateProbe />
      </BudgetGuardrailProvider>
    );
    expect(screen.getByTestId('gate-probe')).toHaveTextContent('open');
  });

  it('useBudgetGuardrailContext returns the provided binding', () => {
    const value = makeContext();
    // Capture via renderHook instead of reassigning an outer variable from a
    // probe component's render (react-doctor react-hooks-js/globals).
    const { result } = renderHook(() => useBudgetGuardrailContext(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <BudgetGuardrailProvider value={value}>{children}</BudgetGuardrailProvider>
      ),
    });
    expect(result.current).toBe(value);
  });
});
