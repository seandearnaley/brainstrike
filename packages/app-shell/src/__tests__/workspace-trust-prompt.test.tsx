/**
 * ADR-0032 — the composer's workspace trust prompt: it asks once for each
 * mounted folder that brings agent configuration and has no answer, records
 * the person's answer with the host, and stays out of the way otherwise.
 */
import '@testing-library/jest-dom/vitest';
import type {
  WorkspaceTrustDecision,
  WorkspaceTrustRoot,
} from '@brainstrike/settings-ui/settings/system/workspace-trust';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantHostWorkspaceDiscovery } from '../assistant-thread-host-context';
import { WorkspaceTrustPrompt } from '../workspace-trust/workspace-trust-prompt';
import { notifyWorkspaceTrustChanged } from '../workspace-trust/workspace-trust-revision';

// The prompt subscribes to activeRootIds purely as a reload trigger.
const storeState = { activeRootIds: ['root-cloned'] as string[] };
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof storeState) => T): T =>
    selector(storeState),
}));

const hostState: {
  host: { readonly workspaceDiscovery: AssistantHostWorkspaceDiscovery } | undefined;
} = { host: undefined };
vi.mock('../assistant-thread-host-context', () => ({
  useAssistantThreadHost: () => hostState.host,
}));

const CLONED: WorkspaceTrustRoot = {
  agentConfiguration: { commands: 0, instructions: 'AGENTS.md', personas: 1, skills: 2 },
  displayName: 'cloned-repo',
  path: '/work/cloned-repo',
  rootId: 'root-cloned',
  trust: 'undecided',
};

function root(overrides: Partial<WorkspaceTrustRoot>): WorkspaceTrustRoot {
  return { ...CLONED, ...overrides };
}

/**
 * The desktop's host discovery, with trust kept in memory: like the desktop
 * capability, a recorded answer tells every trust reader to read again.
 */
function setHost(
  roots: readonly WorkspaceTrustRoot[],
  refusal?: Error
): {
  readonly listTrust: () => Promise<readonly WorkspaceTrustRoot[]>;
  readonly setTrust: (path: string, trust: WorkspaceTrustDecision) => Promise<void>;
} {
  const answers = new Map<string, WorkspaceTrustDecision>();
  const listTrust = vi.fn(async () =>
    roots.map((entry) => ({ ...entry, trust: answers.get(entry.path) ?? entry.trust }))
  );
  const setTrust = vi.fn(async (path: string, trust: WorkspaceTrustDecision) => {
    if (refusal) {
      throw refusal;
    }
    answers.set(path, trust);
    notifyWorkspaceTrustChanged();
  });
  hostState.host = {
    workspaceDiscovery: {
      listCommands: () => Promise.reject(new Error('Commands are not under test')),
      listTrust,
      scanSkills: () => Promise.reject(new Error('Skills are not under test')),
      setTrust,
    },
  };
  return { listTrust, setTrust };
}

afterEach(() => {
  hostState.host = undefined;
});

describe('WorkspaceTrustPrompt', () => {
  it('asks about a folder that brings agent configuration, saying what it holds', async () => {
    setHost([CLONED]);
    render(<WorkspaceTrustPrompt />);

    const prompt = await screen.findByTestId('workspace-trust-prompt-root-cloned');
    expect(prompt).toHaveTextContent('Trust the files in cloned-repo?');
    expect(prompt).toHaveTextContent('This folder has AGENTS.md, 2 skills, and 1 subagent');
  });

  it('asks nothing about a folder already answered or one with no agent configuration', async () => {
    const { listTrust } = setHost([
      root({ rootId: 'root-trusted', trust: 'trusted' }),
      root({ rootId: 'root-restricted', trust: 'restricted' }),
      root({
        agentConfiguration: { commands: 0, instructions: null, personas: 0, skills: 0 },
        rootId: 'root-plain',
      }),
    ]);
    render(<WorkspaceTrustPrompt />);

    await waitFor(() => expect(listTrust).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Workspace trust' })).not.toBeInTheDocument();
  });

  it.each([
    ['Trust folder', 'trusted'],
    ['Keep restricted', 'restricted'],
  ] as const)('"%s" records the answer and stops asking', async (label, decision) => {
    const user = userEvent.setup();
    const { setTrust } = setHost([CLONED]);
    render(<WorkspaceTrustPrompt />);

    const prompt = await screen.findByTestId('workspace-trust-prompt-root-cloned');
    await user.click(within(prompt).getByRole('button', { name: label }));

    expect(setTrust).toHaveBeenCalledWith('/work/cloned-repo', decision);
    await waitFor(() =>
      expect(screen.queryByTestId('workspace-trust-prompt-root-cloned')).not.toBeInTheDocument()
    );
  });

  it('shows a refused answer and keeps asking', async () => {
    const user = userEvent.setup();
    setHost([CLONED], new Error('The agent host is not running'));
    render(<WorkspaceTrustPrompt />);

    const prompt = await screen.findByTestId('workspace-trust-prompt-root-cloned');
    await user.click(within(prompt).getByRole('button', { name: 'Trust folder' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The agent host is not running');
    expect(screen.getByTestId('workspace-trust-prompt-root-cloned')).toBeInTheDocument();
  });

  it('says when it cannot read which folders are trusted', async () => {
    hostState.host = {
      workspaceDiscovery: {
        listCommands: () => Promise.reject(new Error('Commands are not under test')),
        listTrust: () => Promise.reject(new Error('The agent host is not running')),
        scanSkills: () => Promise.reject(new Error('Skills are not under test')),
        setTrust: () => Promise.reject(new Error('Answers are not under test')),
      },
    };
    render(<WorkspaceTrustPrompt />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('could not check which folders you trust');
    expect(alert).toHaveTextContent('The agent host is not running');
  });

  it('asks about a folder that gained agent configuration when the window is shown again', async () => {
    const roots: WorkspaceTrustRoot[] = [
      root({ agentConfiguration: { commands: 0, instructions: null, personas: 0, skills: 0 } }),
    ];
    const { listTrust } = setHost(roots);
    render(<WorkspaceTrustPrompt />);
    await waitFor(() => expect(listTrust).toHaveBeenCalled());
    expect(screen.queryByTestId('workspace-trust-prompt-root-cloned')).not.toBeInTheDocument();

    // A git pull brings AGENTS.md while the person is in another window.
    roots[0] = CLONED;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(await screen.findByTestId('workspace-trust-prompt-root-cloned')).toHaveTextContent(
      'This folder has AGENTS.md'
    );
  });
});
