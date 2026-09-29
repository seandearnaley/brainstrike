import { createContext } from 'react';
import type { SubagentInvocationIndex } from './subagent-invocation-index-model';

export const SubagentInvocationIndexContext = createContext<SubagentInvocationIndex | null>(null);
