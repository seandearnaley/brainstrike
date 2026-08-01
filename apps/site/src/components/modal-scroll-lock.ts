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

  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
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
