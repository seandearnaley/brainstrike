import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAbortControllers } from '../use-abort-controllers';

describe('useAbortControllers', () => {
  it('creates and returns abort controller for root (null path)', () => {
    const { result } = renderHook(() => useAbortControllers());

    let controller: AbortController;
    act(() => {
      controller = result.current.createAbortController(null);
    });

    expect(controller!).toBeInstanceOf(AbortController);
    expect(result.current.rootAbortControllerRef.current).toBe(controller!);
  });

  it('creates and returns abort controller for child path', () => {
    const { result } = renderHook(() => useAbortControllers());

    let controller: AbortController;
    act(() => {
      controller = result.current.createAbortController('/some/path');
    });

    expect(controller!).toBeInstanceOf(AbortController);
    expect(result.current.childAbortControllersRef.current.get('/some/path')).toBe(controller!);
  });

  it('cancels previous root controller when creating new one', () => {
    const { result } = renderHook(() => useAbortControllers());

    let firstController: AbortController;
    let secondController: AbortController;

    act(() => {
      firstController = result.current.createAbortController(null);
    });
    act(() => {
      secondController = result.current.createAbortController(null);
    });

    expect(firstController!.signal.aborted).toBe(true);
    expect(secondController!.signal.aborted).toBe(false);
  });

  it('cancels previous child controller when creating new one for same path', () => {
    const { result } = renderHook(() => useAbortControllers());

    let firstController: AbortController;
    let secondController: AbortController;

    act(() => {
      firstController = result.current.createAbortController('/child/path');
    });
    act(() => {
      secondController = result.current.createAbortController('/child/path');
    });

    expect(firstController!.signal.aborted).toBe(true);
    expect(secondController!.signal.aborted).toBe(false);
  });

  it('cancelRootLoading aborts and clears root controller', () => {
    const { result } = renderHook(() => useAbortControllers());

    let controller: AbortController;
    act(() => {
      controller = result.current.createAbortController(null);
    });

    expect(controller!.signal.aborted).toBe(false);

    act(() => {
      result.current.cancelRootLoading();
    });

    expect(controller!.signal.aborted).toBe(true);
    expect(result.current.rootAbortControllerRef.current).toBeNull();
  });

  it('cancelChildLoading aborts and removes specific child controller', () => {
    const { result } = renderHook(() => useAbortControllers());

    let controller1: AbortController;
    let controller2: AbortController;

    act(() => {
      controller1 = result.current.createAbortController('/path/one');
      controller2 = result.current.createAbortController('/path/two');
    });

    expect(controller1!.signal.aborted).toBe(false);
    expect(controller2!.signal.aborted).toBe(false);

    act(() => {
      result.current.cancelChildLoading('/path/one');
    });

    expect(controller1!.signal.aborted).toBe(true);
    expect(controller2!.signal.aborted).toBe(false);
    expect(result.current.childAbortControllersRef.current.has('/path/one')).toBe(false);
    expect(result.current.childAbortControllersRef.current.has('/path/two')).toBe(true);
  });

  it('cancelAllLoading aborts root and all child controllers', () => {
    const { result } = renderHook(() => useAbortControllers());

    let rootController: AbortController;
    let childController1: AbortController;
    let childController2: AbortController;

    act(() => {
      rootController = result.current.createAbortController(null);
      childController1 = result.current.createAbortController('/child/one');
      childController2 = result.current.createAbortController('/child/two');
    });

    expect(rootController!.signal.aborted).toBe(false);
    expect(childController1!.signal.aborted).toBe(false);
    expect(childController2!.signal.aborted).toBe(false);

    act(() => {
      result.current.cancelAllLoading();
    });

    expect(rootController!.signal.aborted).toBe(true);
    expect(childController1!.signal.aborted).toBe(true);
    expect(childController2!.signal.aborted).toBe(true);
    expect(result.current.rootAbortControllerRef.current).toBeNull();
    expect(result.current.childAbortControllersRef.current.size).toBe(0);
  });

  it('cancelAllChildLoading aborts children without cancelling the root', () => {
    const { result } = renderHook(() => useAbortControllers());

    let rootController: AbortController;
    let childController1: AbortController;
    let childController2: AbortController;
    act(() => {
      rootController = result.current.createAbortController(null);
      childController1 = result.current.createAbortController('/child/one');
      childController2 = result.current.createAbortController('/child/two');
    });

    act(() => {
      result.current.cancelAllChildLoading();
    });

    expect(rootController!.signal.aborted).toBe(false);
    expect(result.current.rootAbortControllerRef.current).toBe(rootController!);
    expect(childController1!.signal.aborted).toBe(true);
    expect(childController2!.signal.aborted).toBe(true);
    expect(result.current.childAbortControllersRef.current.size).toBe(0);
  });

  it('removeChildController removes controller without aborting', () => {
    const { result } = renderHook(() => useAbortControllers());

    let controller: AbortController;
    act(() => {
      controller = result.current.createAbortController('/completed/path');
    });

    expect(result.current.childAbortControllersRef.current.has('/completed/path')).toBe(true);

    act(() => {
      result.current.removeChildController('/completed/path');
    });

    // Controller should be removed but NOT aborted (it completed successfully)
    expect(controller!.signal.aborted).toBe(false);
    expect(result.current.childAbortControllersRef.current.has('/completed/path')).toBe(false);
  });

  it('removeChildController does not clear a newer controller for the same path', () => {
    const { result } = renderHook(() => useAbortControllers());

    let firstController: AbortController;
    let secondController: AbortController;
    act(() => {
      firstController = result.current.createAbortController('/completed/path');
      secondController = result.current.createAbortController('/completed/path');
    });

    act(() => {
      result.current.removeChildController('/completed/path', firstController);
    });

    expect(result.current.childAbortControllersRef.current.get('/completed/path')).toBe(
      secondController!
    );

    act(() => {
      result.current.removeChildController('/completed/path', secondController);
    });

    expect(result.current.childAbortControllersRef.current.has('/completed/path')).toBe(false);
  });

  it('cancelChildLoading handles non-existent path gracefully', () => {
    const { result } = renderHook(() => useAbortControllers());

    // Should not throw when canceling non-existent path
    expect(() => {
      act(() => {
        result.current.cancelChildLoading('/non/existent');
      });
    }).not.toThrow();
  });

  it('removeChildController handles non-existent path gracefully', () => {
    const { result } = renderHook(() => useAbortControllers());

    // Should not throw when removing non-existent path
    expect(() => {
      act(() => {
        result.current.removeChildController('/non/existent');
      });
    }).not.toThrow();
  });
});
