import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssistantForegroundActivityForTests,
  getAssistantForegroundActivitySnapshot,
} from '../assistant-foreground-activity';
import { useAssistantRequestLifecycle } from '../hooks/use-assistant-request-lifecycle';
import { createRepositoryStub } from './helpers/assistant-thread-repository-stub';

// Owner decision 2026-10-17: with no durable memory backend (web), a turn runs
// without memory instead of failing its preparation. The request carries no
// memory block, and its run id stays with the prepared request.

function repositoryCreating(runId: string): AssistantThreadRepository {
  return createRepositoryStub({
    createThreadRun: vi.fn(async (input) => ({
      ...input,
      createdAt: 0,
      id: runId,
      status: 'running',
    })),
  });
}

function renderMemoryless(repository: AssistantThreadRepository, memoryBackendAvailable?: false) {
  return renderHook(() =>
    useAssistantRequestLifecycle({
      assistantThreadRepository: repository,
      focusedRootId: 'root-a',
      ...(memoryBackendAvailable === undefined ? {} : { memoryBackendAvailable }),
      memoryResourceId: 'workspace-a',
      modelSettings: undefined,
      permissionEnforceable: false,
      planModeAvailable: false,
      providerOptions: undefined,
      requestData: { enabledNativeToolIds: ['filesystem.read_file'] },
      resolvedModelName: 'gpt-5.2',
      selectedMemoryThreadId: 'thread-a',
      selectedProvider: 'openai',
    })
  );
}

describe('useAssistantRequestLifecycle without a memory backend', () => {
  afterEach(() => {
    __resetAssistantForegroundActivityForTests();
  });

  it('runs a turn without memory and completes it by its prepared request', async () => {
    const repository = repositoryCreating('run-web');
    const { result } = renderMemoryless(repository, false);

    const prepared = await act(async () => result.current.prepareRequestData());

    expect(repository.createThreadRun).toHaveBeenCalledTimes(1);
    expect(prepared).toMatchObject({ enabledNativeToolIds: ['filesystem.read_file'] });
    expect(prepared).not.toHaveProperty('memory');
    expect(getAssistantForegroundActivitySnapshot()).toBe(true);

    await act(async () => {
      await result.current.completePreparedRequest(prepared, 'completed');
    });
    expect(repository.completeThreadRun).toHaveBeenCalledWith('run-web', { status: 'completed' });
    expect(getAssistantForegroundActivitySnapshot()).toBe(false);
  });

  it("follows this shell's own capability when none is passed", async () => {
    // jsdom has no agent host, so this shell has no durable memory backend.
    const repository = repositoryCreating('run-default');
    const { result } = renderMemoryless(repository);

    const prepared = await act(async () => result.current.prepareRequestData());

    expect(prepared).not.toHaveProperty('memory');
    await act(async () => {
      await result.current.completePreparedRequest(prepared, 'failed', 'stopped');
    });
    expect(repository.completeThreadRun).toHaveBeenCalledWith('run-default', {
      error: 'stopped',
      status: 'failed',
    });
  });
});
