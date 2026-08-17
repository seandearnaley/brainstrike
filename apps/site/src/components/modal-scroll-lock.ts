interface ScrollLockBody {
  readonly style: Pick<
    CSSStyleDeclaration,
    'left' | 'overflow' | 'position' | 'right' | 'top' | 'width'
  >;
}

interface ScrollLockViewport {
  readonly scrollTo: (options: ScrollToOptions) => void;
  readonly scrollX: number;
  readonly scrollY: number;
}

export interface DocumentScrollLock {
  readonly release: () => void;
}

let activeLockCount = 0;

// Section navigation must not compute scroll targets while the lock is
// engaged: `position: fixed` collapses `window.scrollY` to 0, which makes
// document-top math negative for sections above the locked position.
export function isDocumentScrollLocked(): boolean {
  return activeLockCount > 0;
}

export function lockDocumentScroll(
  body: ScrollLockBody = document.body,
  viewport: ScrollLockViewport = window
): DocumentScrollLock {
  const { scrollX, scrollY } = viewport;
  const previous = {
    left: body.style.left,
    overflow: body.style.overflow,
    position: body.style.position,
    right: body.style.right,
    top: body.style.top,
    width: body.style.width,
  };

  body.style.position = 'fixed';
  body.style.top = `${-scrollY}px`;
  body.style.right = '0';
  body.style.left = `${-scrollX}px`;
  body.style.width = '100%';
  body.style.overflow = 'hidden';
  activeLockCount += 1;

  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      activeLockCount -= 1;
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.right = previous.right;
      body.style.left = previous.left;
      body.style.width = previous.width;
      body.style.overflow = previous.overflow;
      viewport.scrollTo({ behavior: 'instant', left: scrollX, top: scrollY });
    },
  };
}
