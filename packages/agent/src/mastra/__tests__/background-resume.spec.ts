import { describe, expect, it } from 'vitest';
import { createLiveDecisionChannel, LiveDecisionUnavailableError } from '../live-decision-channel';
import {
  createNativeManager,
  macrotask,
  parkingTool,
  startLeg,
  TOOL,
  type ToolExecute,
  type ToolMap,
  until,
} from './fixtures/background-resume-harness';

describe('createBackgroundResumeStream executor registration (BST-1749)', () => {
  it('registers every resumed executor before Mastra is asked to resume any task', async () => {
    // Mastra reads the task context when its workflow runs the task; a resume
    // issued before registration lands races that lookup and can fail the
    // task with "No executor registered".
    const tools = Promise.withResolvers<ToolMap>();
    const native = createNativeManager();
    const { ended, leg } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1'), native.add('t2')],
      tools: tools.promise,
    });
    try {
      await macrotask();
      await macrotask();
      expect(native.calls).toEqual([]);
    } finally {
      tools.resolve({ [TOOL]: parkingTool() });
    }
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(leg.status).toBe('suspended');
    expect(native.calls.slice(0, 4)).toEqual([
      'register:t1',
      'register:t2',
      'resume:t1',
      'resume:t2',
    ]);
    // Mastra accepted both resumes, so both keep their context.
    expect(native.calls.filter((call) => call.startsWith('deregister'))).toEqual([]);
  }, 2000);

  it('owns the live decision seam before it registers its executors', async () => {
    // Registration awaits `getToolsForExecution`. The leg must already own the
    // seam by then: its first run event streams immediately, and a decision
    // delivered from then on — a live session grant answering a sibling parked
    // on an earlier leg — must reach this leg instead of queueing as
    // 'no-live-run' (desktop `delegated-sibling-grant.integration.test.ts`).
    const tools = Promise.withResolvers<ToolMap>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const sibling = native.add('t2');
    const { ended } = startLeg({
      channel,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: tools.promise,
    });
    try {
      await macrotask();
      // Registration is still pending, so ownership cannot wait on it.
      expect(native.calls).toEqual([]);
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg registered its executors before it owned the live seam.');
      }
      expect(() => owner.reserve([sibling]).release()).not.toThrow();
    } finally {
      tools.resolve({ [TOOL]: parkingTool() });
    }
    await expect(ended).resolves.toEqual({ error: undefined });
  }, 2000);

  it('fails the leg before any resume when a resumed executor is unavailable, keeping no context', async () => {
    // Siblings carry different delegation tools, so registration can fail on
    // the SECOND task: the first task's context is already registered and must
    // not outlive the leg that never resumed it.
    const native = createNativeManager();
    const { ended } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1'), native.add('t2', 'agent-review')],
      tools: Promise.resolve({ [TOOL]: parkingTool() }),
    });
    const { error } = await ended;
    expect(error).toMatchObject({ message: 'The original background executor is unavailable.' });
    expect(native.calls).toEqual(['register:t1', 'deregister:t1']);
  }, 2000);

  it('deregisters the tail Mastra never resumed when a resume fails part-way through the leg', async () => {
    const native = createNativeManager({ refuseResume: new Set(['t1']) });
    const { ended } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1'), native.add('t2')],
      tools: Promise.resolve({ [TOOL]: parkingTool() }),
    });
    const { error } = await ended;
    expect(error).toMatchObject({
      message: "Cannot resume task in status 'cancelled' (expected 'suspended')",
    });
    expect(native.calls).toEqual([
      'register:t1',
      'register:t2',
      'resume:t1',
      'deregister:t1',
      'deregister:t2',
    ]);
  }, 2000);

  it('a live resume Mastra refuses joins nothing: the leg still closes as a pause and keeps no executor for it', async () => {
    const gate = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager({ refuseResume: new Set(['t2']) });
    const refused = native.add('t2');
    const { ended, leg } = startLeg({
      channel,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool(gate.promise) }),
    });
    await until(() => native.calls.includes('resume:t1'));
    const owner = channel.owner;
    if (!owner) {
      throw new Error('The resume leg does not own its live decision channel.');
    }
    const reservation = owner.reserve([refused]);
    await expect(
      reservation.resume([{ resumeData: { approved: true }, task: refused }])
    ).rejects.toThrow("Cannot resume task in status 'cancelled'");
    gate.resolve();
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(leg.status).toBe('suspended');
    expect(native.calls).toContain('deregister:t2');
  }, 2000);

  it('a task cancelled before Mastra ran its resumed executor does not hang the join under a parked root', async () => {
    const native = createNativeManager({ cancelOnResume: new Set(['t1']) });
    const { ended, leg } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool() }),
    });
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(leg.status).toBe('suspended');
    expect(native.calls).not.toContain('execute:t1');
  }, 2000);

  it('keeps the context of a task another caller already resumed', async () => {
    // The leg owns the seam across its whole registration window, so a live
    // decision can register and resume a task this leg is about to resume.
    // Mastra then refuses the leg's duplicate resume — and that refusal must
    // NOT drop the context Mastra is about to look up for the running task.
    const channel = createLiveDecisionChannel();
    const running = Promise.withResolvers<void>();
    let live: Promise<void> | undefined;
    const native = createNativeManager();
    const duplicate = native.add('t1');
    native.setBeforeResume(async () => {
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      const reservation = owner.reserve([duplicate]);
      live = reservation.resume([{ resumeData: { approved: true }, task: duplicate }]);
      await live;
      // Mastra picks the task up: the leg's own resume then finds it running.
      await macrotask();
    });
    const { ended } = startLeg({
      channel,
      manager: native.manager,
      resumes: [duplicate],
      // The live-resumed child is still working when the leg's own resume runs.
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      const { error } = await ended;
      expect(error).toMatchObject({
        message: "Cannot resume task in status 'running' (expected 'suspended')",
      });
      await expect(live).resolves.toBeUndefined();
      expect(native.calls).not.toContain('deregister:t1');
      expect(native.calls).toContain('execute:t1');
    } finally {
      running.resolve();
    }
  }, 2000);

  it('never re-registers or deregisters a task a live decision already resumed', async () => {
    // The leg owns the seam across its whole registration window, so a live
    // decision can resume a task the leg has NOT reached yet. Registering that
    // task again would overwrite a running task's context, orphan the join the
    // reservation already pushed, and let the leg's own refusal deregister it.
    const registering = Promise.withResolvers<void>();
    const running = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const first = native.add('t1');
    const ahead = native.add('t2');
    const { ended, leg } = startLeg({
      channel,
      holdFirstRegistration: registering.promise,
      manager: native.manager,
      resumes: [first, ahead],
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      await until(() => channel.owner !== undefined);
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      // t2 is resumed and running while the leg still awaits t1's registration.
      await owner.reserve([ahead]).resume([{ resumeData: { approved: true }, task: ahead }]);
      await until(() => native.calls.includes('execute:t2'));
      registering.resolve();
      await until(() => native.calls.includes('resume:t1'));
      expect(native.calls).not.toContain('deregister:t2');
      expect(native.calls.filter((call) => call === 'register:t2')).toHaveLength(1);
    } finally {
      running.resolve();
    }
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(leg.status).toBe('suspended');
  }, 2000);

  it('shares one registration when a live decision resumes a task the leg also holds', async () => {
    // Single-flight: the leg's registration and the decision's are the SAME
    // one, so the context Mastra runs is never replaced and the join already
    // pushed is never orphaned. Its terminal still settles that join.
    const running = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const shared = native.add('t1');
    const { ended, leg } = startLeg({
      channel,
      manager: native.manager,
      resumes: [shared],
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      await owner.reserve([shared]).resume([{ resumeData: { approved: true }, task: shared }]);
      // The task is cancelled while its executor is still in flight.
      native.cancel('t1');
      await expect(ended).resolves.toEqual({ error: undefined });
      expect(leg.status).toBe('suspended');
      expect(native.calls.filter((call) => call === 'register:t1')).toHaveLength(1);
      expect(native.calls.filter((call) => call === 'resume:t1')).toHaveLength(1);
      expect(native.calls).not.toContain('deregister:t1');
    } finally {
      running.resolve();
    }
  }, 2000);

  it('keeps the context of a live resume that is in flight when the leg is stopped', async () => {
    // The leg releases the contexts Mastra never accepted when it ends. A
    // decision whose `manager.resume` is in flight at that moment is about to
    // be accepted, so its context must survive the release: dropping it makes
    // Mastra's own lookup fail with "No executor registered".
    const running = Promise.withResolvers<void>();
    const stop = new AbortController();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const sibling = native.add('t2');
    const { ended } = startLeg({
      abortSignal: stop.signal,
      channel,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      // The root Stop tears the leg down while this resume is in flight.
      native.setBeforeResume(async () => {
        stop.abort(new Error('User stopped the root.'));
        await ended;
      });
      await owner.reserve([sibling]).resume([{ resumeData: { approved: true }, task: sibling }]);
      await until(() =>
        native.calls.some((call) => call === 'execute:t2' || call === 'no-executor:t2')
      );
      expect(native.calls).toContain('execute:t2');
      expect(native.calls).not.toContain('deregister:t2');
    } finally {
      running.resolve();
    }
  }, 2000);

  it('refuses a live registration that lands after the leg released its executors', async () => {
    // Same window, opposite order: nothing would drain a context registered
    // after the release, and the manager outlives the leg.
    const holding = Promise.withResolvers<void>();
    const running = Promise.withResolvers<void>();
    const stop = new AbortController();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const sibling = native.add('t2');
    const { ended } = startLeg({
      abortSignal: stop.signal,
      channel,
      holdLiveRegistration: holding.promise,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      const refused = owner
        .reserve([sibling])
        .resume([{ resumeData: { approved: true }, task: sibling }]);
      await macrotask();
      stop.abort(new Error('User stopped the root.'));
      await expect(ended).resolves.toMatchObject({
        error: { message: 'User stopped the root.' },
      });
      holding.resolve();
      await expect(refused).rejects.toBeInstanceOf(LiveDecisionUnavailableError);
      // The shared manager is never touched: no registration to undo.
      expect(native.calls).not.toContain('resume:t2');
      expect(native.calls).not.toContain('register:t2');
      expect(native.calls).not.toContain('deregister:t2');
    } finally {
      holding.resolve();
      running.resolve();
    }
  }, 2000);

  it('the drain keeps a context Mastra accepted while a live decision shared its registration', async () => {
    // Single-flight means the decision shares the leg's registration, so the
    // task is accepted twice over by the time the leg is stopped: the release
    // must leave the context of a task Mastra accepted and is running.
    const holding = Promise.withResolvers<void>();
    const running = Promise.withResolvers<void>();
    const stop = new AbortController();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const shared = native.add('t1');
    // The decision enters `register` BEFORE the leg's own resume is accepted.
    native.setBeforeResume(async () => {
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      const live = owner
        .reserve([shared])
        .resume([{ resumeData: { approved: true }, task: shared }]);
      live.catch(() => undefined);
      await macrotask();
    });
    const { ended } = startLeg({
      abortSignal: stop.signal,
      channel,
      holdLiveRegistration: holding.promise,
      manager: native.manager,
      resumes: [shared],
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      stop.abort(new Error('User stopped the root.'));
      await expect(ended).resolves.toMatchObject({
        error: { message: 'User stopped the root.' },
      });
      holding.resolve();
      await macrotask();
      expect(native.calls).not.toContain('deregister:t1');
      expect(native.calls).not.toContain('no-executor:t1');
    } finally {
      holding.resolve();
      running.resolve();
    }
  }, 2000);

  it('keeps the context when a second concurrent resume is refused while the first is in flight', async () => {
    // A live decision can resume a task whose own `manager.resume` this leg
    // has in flight: the row is still suspended when the decision selects it.
    // The refused call must not drop the context the accepted one needs.
    const running = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager({ refuseConcurrentResume: new Set(['t1']) });
    const shared = native.add('t1');
    let live: Promise<void> | undefined;
    native.setBeforeResume(async () => {
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      live = owner.reserve([shared]).resume([{ resumeData: { approved: true }, task: shared }]);
      await expect(live).rejects.toThrow("Cannot resume task in status 'running'");
    });
    const { ended } = startLeg({
      channel,
      manager: native.manager,
      resumes: [shared],
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      await until(() =>
        native.calls.some((call) => call === 'execute:t1' || call === 'no-executor:t1')
      );
      expect(native.calls).toContain('execute:t1');
      expect(native.calls).not.toContain('deregister:t1');
      running.resolve();
      await expect(ended).resolves.toEqual({ error: undefined });
    } finally {
      running.resolve();
    }
  }, 2000);

  it('registers afresh when a parked task is resumed again in the same leg', async () => {
    // A terminal retires the task's registration, so the second resume is a
    // new execution with its own join: the leg cannot close while it runs.
    const sibling = Promise.withResolvers<void>();
    const secondRead = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const parked = native.add('t1');
    let runs = 0;
    const tool: { readonly execute: ToolExecute } = {
      execute: async (args, options) => {
        if (String(args['prompt']).endsWith('t2')) {
          await sibling.promise;
        } else {
          runs += 1;
          if (runs > 1) {
            await secondRead.promise;
            // The second execution is in flight up to here; the leg's own
            // ledger of calls carries the order.
            native.calls.push('second-read:t1');
          }
        }
        await options.suspend?.({ reason: 'next gated read' });
      },
    };
    const { ended, leg } = startLeg({
      channel,
      manager: native.manager,
      resumes: [parked, native.add('t2')],
      tools: Promise.resolve({ [TOOL]: tool }),
    });
    try {
      // t1 parked again; t2 keeps the leg's wait open.
      await until(() => native.calls.filter((call) => call === 'execute:t1').length === 1);
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      await owner.reserve([parked]).resume([{ resumeData: { approved: true }, task: parked }]);
      await until(() => native.calls.filter((call) => call === 'execute:t1').length === 2);
      // Satisfy the WAIT while the second execution is still in flight: the
      // leg releases its owner the moment every awaited terminal is in, so
      // from here only the join that second registration pushed holds the leg
      // open. Asserted by order, never by a timing window.
      sibling.resolve();
      await until(() => channel.owner === undefined);
      expect(native.calls).not.toContain('shutdown');
      secondRead.resolve();
      await expect(ended).resolves.toEqual({ error: undefined });
      expect(leg.status).toBe('suspended');
      expect(native.calls.filter((call) => call === 'register:t1')).toHaveLength(2);
      // `indexOf` is -1 for a missing marker, so the order check below needs
      // the marker's presence asserted locally to mean anything.
      expect(native.calls).toContain('second-read:t1');
      expect(native.calls.indexOf('second-read:t1')).toBeLessThan(native.calls.indexOf('shutdown'));
    } finally {
      secondRead.resolve();
      sibling.resolve();
    }
  }, 2000);

  it('refuses a registration a terminal retired while its tools were still resolving', async () => {
    // A terminal retires the task's registration so a re-resumed child can
    // register afresh — but a registration whose tools are still resolving
    // cannot be retired by forgetting it. The next caller starts a second
    // registration, and the first still commits when it lands: a second
    // context replaces the one Mastra is about to look up, and the executor
    // whose join that second caller pushed is replaced too. The retired
    // registration must land on nothing and touch the shared manager not at
    // all, exactly as one that lands after the drain does.
    const legRunning = Promise.withResolvers<void>();
    const retiredTools = Promise.withResolvers<void>();
    const freshTools = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const cancelled = native.add('t2');
    const { ended, leg } = startLeg({
      channel,
      holdLiveRegistration: (live) => (live === 1 ? retiredTools.promise : freshTools.promise),
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool(legRunning.promise) }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      // This decision's registration is in flight when a Stop cancels the row.
      const retired = owner
        .reserve([cancelled])
        .resume([{ resumeData: { approved: true }, task: cancelled }]);
      const retiredOutcome = retired.then(
        () => undefined,
        (error: unknown) => error
      );
      // The cancel's own ledger row proves the leg recorded that terminal.
      let terminalSeen = false;
      const release = native.holdNextRead(() => {
        terminalSeen = true;
      });
      native.cancel('t2');
      await until(() => terminalSeen);
      release();
      // A second delivery for the same row registers it afresh and lands FIRST.
      const second = owner
        .reserve([cancelled])
        .resume([{ resumeData: { approved: true }, task: cancelled }]);
      const secondOutcome = second.then(
        () => undefined,
        (error: unknown) => error
      );
      freshTools.resolve();
      await until(() => native.calls.includes('resume:t2'));
      retiredTools.resolve();
      await expect(retiredOutcome).resolves.toBeInstanceOf(LiveDecisionUnavailableError);
      await expect(secondOutcome).resolves.toMatchObject({
        message: "Cannot resume task in status 'cancelled' (expected 'suspended')",
      });
      expect(native.calls.filter((call) => call === 'register:t2')).toHaveLength(1);
      expect(native.calls.filter((call) => call === 'resume:t2')).toHaveLength(1);
    } finally {
      retiredTools.resolve();
      freshTools.resolve();
      legRunning.resolve();
    }
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(leg.status).toBe('suspended');
  }, 2000);

  it('refuses a reservation taken while the leg was live but used after the drain', async () => {
    // The reservation passed `reserve` before the wait closed, so only
    // `register` can still refuse it. Its task was registered and never
    // resumed, so the drain deregistered that context: handing the cached
    // executor back would resume a task Mastra can no longer look up.
    const registering = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager({ refuseResume: new Set(['t1']) });
    const unresumed = native.add('t2');
    const { ended } = startLeg({
      channel,
      holdFirstRegistration: registering.promise,
      manager: native.manager,
      resumes: [native.add('t1'), unresumed],
      tools: Promise.resolve({ [TOOL]: parkingTool() }),
    });
    await until(() => channel.owner !== undefined);
    const owner = channel.owner;
    if (!owner) {
      throw new Error('The leg does not own its live decision seam.');
    }
    // Taken while the leg is still waiting; used only after it has drained.
    const reservation = owner.reserve([unresumed]);
    registering.resolve();
    await expect(ended).resolves.toMatchObject({
      error: { message: "Cannot resume task in status 'cancelled' (expected 'suspended')" },
    });
    expect(native.calls).toContain('deregister:t2');
    await expect(
      reservation.resume([{ resumeData: { approved: true }, task: unresumed }])
    ).rejects.toBeInstanceOf(LiveDecisionUnavailableError);
    expect(native.calls).not.toContain('resume:t2');
    expect(native.calls).not.toContain('no-executor:t2');
  }, 2000);

  it('a resumed tool that writes after its leg closed does not throw into the execution', async () => {
    // A cancel settles the join while the executor is still in flight, so the
    // leg can close before the tool returns; its next write has nowhere to go
    // and must not fail the tool.
    const stuck = Promise.withResolvers<void>();
    let lateWrite: unknown = 'not attempted';
    const native = createNativeManager();
    const { ended } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({
        [TOOL]: {
          execute: async (_args, options) => {
            await stuck.promise;
            try {
              await options.outputWriter?.({ type: 'late-child-frame' });
              lateWrite = 'written';
            } catch (error) {
              lateWrite = error;
            }
          },
        },
      }),
    });
    await until(() => native.calls.includes('execute:t1'));
    native.cancel('t1');
    await expect(ended).resolves.toEqual({ error: undefined });
    stuck.resolve();
    await until(() => lateWrite !== 'not attempted');
    expect(lateWrite).toBe('written');
  }, 2000);

  it("a resumed executor's child is watched from its execution's start to its end, fed by its own writer", async () => {
    // A resume leg's host executor publishes its child's parts itself, never as
    // task output, so it feeds the child's own watchdog itself.
    const native = createNativeManager();
    const { ended, watches } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({
        [TOOL]: {
          execute: async (_args, options) => {
            await options.outputWriter?.({ type: 'child-frame' });
            await options.suspend?.({ reason: 'next gated read' });
          },
        },
      }),
    });
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(watches).toEqual(['watch:t1', 'observe:t1', 'end:t1']);
  }, 2000);

  it('a task cancelled while its resumed executor is still in flight settles the join', async () => {
    // Mastra publishes `task.cancelled` BEFORE the execution settles (it joins
    // that execution itself, under its 5s grace: `#joinTaskCancellation`), and
    // an in-flight `execute` settles only if the tool honours the abort signal
    // Mastra hands it. The leg's own join must not depend on that: the
    // terminal settles it, and `manager.shutdown()` performs the bounded join.
    const stuck = Promise.withResolvers<void>();
    const native = createNativeManager();
    const { ended, leg } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({
        [TOOL]: {
          execute: async () => {
            await stuck.promise;
          },
        },
      }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      native.cancel('t1');
      await expect(ended).resolves.toEqual({ error: undefined });
      expect(leg.status).toBe('suspended');
      expect(native.calls).toContain('shutdown');
    } finally {
      stuck.resolve();
    }
  }, 2000);

  it('the pause branch still joins a resumed executor whose host join outlives its suspension', async () => {
    // Only a running executor parks, so a suspension never settles the join:
    // the executor that parked settles it, after its host join.
    const hostJoin = Promise.withResolvers<void>();
    const native = createNativeManager();
    const { ended } = startLeg({
      afterToolCall: () => hostJoin.promise,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool() }),
    });
    await until(() => native.calls.includes('execute:t1'));
    await macrotask();
    await macrotask();
    expect(native.calls).not.toContain('shutdown');
    hostJoin.resolve();
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(native.calls).toContain('shutdown');
  }, 2000);
});
