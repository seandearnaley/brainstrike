import { lazy } from 'react';

export const ConnectedPromptManagerLazy = lazy(async () => {
  const module = await import('./connected-prompt-manager');
  return { default: module.ConnectedPromptManager };
});
