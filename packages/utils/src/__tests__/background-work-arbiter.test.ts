import {
  __resetBackgroundWorkArbiterForTests,
  acquireBackgroundWorkPauseReason,
  getBackgroundWorkArbiterSnapshot,
  getBackgroundWorkPauseReasonLabel,
  getBackgroundWorkPauseReasonLabels,
  registerBackgroundWorkPauseHandler,
  setBackgroundWorkManualPause,
  subscribeToBackgroundWorkArbiter,
} from '../background-work-arbiter';

describe('background-work-arbiter', () => {
  beforeEach(() => {
    __resetBackgroundWorkArbiterForTests();
  });

  it('sets and clears manual pause state', () => {
    expect(getBackgroundWorkArbiterSnapshot()).toEqual({
      automaticPauseReasons: [],
      backgroundIndexingPaused: false,
      manualPause: false,
    });

    setBackgroundWorkManualPause(true);
    expect(getBackgroundWorkArbiterSnapshot()).toEqual({
      automaticPauseReasons: [],
      backgroundIndexingPaused: true,
      manualPause: true,
    });

    setBackgroundWorkManualPause(false);
    expect(getBackgroundWorkArbiterSnapshot()).toEqual({
      automaticPauseReasons: [],
      backgroundIndexingPaused: false,
      manualPause: false,
    });
  });

  it('pauses registered handlers when the first automatic reason is acquired', async () => {
    const pause = vi.fn(async () => undefined);
    registerBackgroundWorkPauseHandler('background-indexing', { pause });

    const release = await acquireBackgroundWorkPauseReason('local-llm');

    expect(pause).toHaveBeenCalledTimes(1);
    expect(getBackgroundWorkArbiterSnapshot()).toEqual({
      automaticPauseReasons: ['local-llm'],
      backgroundIndexingPaused: true,
      manualPause: false,
    });

    release();

    expect(getBackgroundWorkArbiterSnapshot()).toEqual({
      automaticPauseReasons: [],
      backgroundIndexingPaused: false,
      manualPause: false,
    });
  });

  it('does not re-pause handlers while an automatic pause is already active', async () => {
    const pause = vi.fn(async () => undefined);
    registerBackgroundWorkPauseHandler('background-indexing', { pause });

    const releaseA = await acquireBackgroundWorkPauseReason('local-llm');
    const releaseB = await acquireBackgroundWorkPauseReason('local-llm');

    expect(pause).toHaveBeenCalledTimes(1);
    expect(getBackgroundWorkArbiterSnapshot().automaticPauseReasons).toEqual(['local-llm']);

    releaseA();
    expect(getBackgroundWorkArbiterSnapshot().backgroundIndexingPaused).toBe(true);

    releaseB();
    expect(getBackgroundWorkArbiterSnapshot().backgroundIndexingPaused).toBe(false);
  });

  it('releases the acquired pause reason if a pause handler fails', async () => {
    registerBackgroundWorkPauseHandler('background-indexing', {
      pause: vi.fn(async () => {
        throw new Error('pause failed');
      }),
    });

    await expect(acquireBackgroundWorkPauseReason('local-llm')).rejects.toThrow('pause failed');
    expect(getBackgroundWorkArbiterSnapshot()).toEqual({
      automaticPauseReasons: [],
      backgroundIndexingPaused: false,
      manualPause: false,
    });
  });

  it('notifies subscribers only when the snapshot changes', () => {
    const subscriber = vi.fn();
    const unsubscribe = subscribeToBackgroundWorkArbiter(subscriber);

    setBackgroundWorkManualPause(true);
    setBackgroundWorkManualPause(true);

    expect(subscriber).toHaveBeenCalledTimes(1);

    unsubscribe();
    setBackgroundWorkManualPause(false);

    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it('keeps a newer pause handler when an older unregister callback runs', async () => {
    const firstPause = vi.fn();
    const secondPause = vi.fn();

    const unregisterFirst = registerBackgroundWorkPauseHandler('background-indexing', {
      pause: firstPause,
    });
    const unregisterSecond = registerBackgroundWorkPauseHandler('background-indexing', {
      pause: secondPause,
    });

    unregisterFirst();

    const release = await acquireBackgroundWorkPauseReason('local-llm');

    expect(firstPause).not.toHaveBeenCalled();
    expect(secondPause).toHaveBeenCalledTimes(1);

    release();
    unregisterSecond();
  });

  it('returns an idempotent release callback for acquired pause reasons', async () => {
    const release = await acquireBackgroundWorkPauseReason('local-llm');

    release();
    release();

    expect(getBackgroundWorkArbiterSnapshot()).toEqual({
      automaticPauseReasons: [],
      backgroundIndexingPaused: false,
      manualPause: false,
    });
  });

  it('maps automatic pause reasons to display labels', () => {
    expect(getBackgroundWorkPauseReasonLabel('local-llm')).toBe('Paused for local assistant');
    expect(getBackgroundWorkPauseReasonLabels(['local-llm'])).toEqual([
      'Paused for local assistant',
    ]);
  });
});
