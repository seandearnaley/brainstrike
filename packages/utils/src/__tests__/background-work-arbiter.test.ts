import {
  __resetBackgroundWorkArbiterForTests,
  acquireBackgroundWorkPauseReason,
  getBackgroundWorkArbiterSnapshot,
  registerBackgroundWorkPauseHandler,
  setBackgroundWorkManualPause,
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
});
