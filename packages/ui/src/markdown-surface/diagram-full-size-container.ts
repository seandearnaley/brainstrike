import { createContext } from 'react';

/**
 * The element a diagram's full-size view fills, such as the chat panel. A
 * surface without one gets a view that fills the window. Its own module, so a
 * surface can provide it without loading the diagram renderer.
 */
export const DiagramFullSizeContainerContext = createContext<HTMLElement | null>(null);
