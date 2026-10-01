import { createContext } from 'react';

/** Renderer-only state of exactly owned, terminal delegation display copies. */
export const CompletedSubagentCallsContext = createContext<ReadonlySet<string>>(new Set());
