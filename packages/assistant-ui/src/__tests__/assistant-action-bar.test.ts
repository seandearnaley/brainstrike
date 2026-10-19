import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME,
  ASSISTANT_ACTION_BAR_CLASSNAME,
} from '../assistant-action-bar';
import { USER_ACTION_BAR_CLASSNAME } from '../user-message';

// UserMessage/UserActionBar were extracted from the panel root to
// user-message.tsx (panel-root source-file budget) — the source scans below
// read the module that actually holds them.
const userMessageSourceFile = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../user-message.tsx'),
  'utf8'
);

describe('AssistantActionBar styling', () => {
  it('drops the floating box (no border/shadow/background/rounded)', () => {
    for (const token of ['border', 'shadow', 'bg-background', 'rounded-md']) {
      expect(ASSISTANT_ACTION_BAR_CLASSNAME).not.toContain(token);
    }
  });
  it('keeps floating on hover', () => {
    expect(ASSISTANT_ACTION_BAR_CLASSNAME).toContain('data-[floating]:absolute');
  });
  it('uses smaller buttons', () => {
    expect(ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME).toContain('size-5');
  });
});

describe('UserActionBar styling (BST-898: no hover layout shift)', () => {
  it('floats absolutely instead of mounting in flow on hover', () => {
    // Without this, the library mounts the bar IN FLOW (grid row 2, col 1)
    // whenever the message is hovered -- two stacked size-6 buttons (~56px)
    // push the row taller than a one-line message bubble, shifting every
    // message below it down for the duration of the hover.
    expect(USER_ACTION_BAR_CLASSNAME).toContain('data-[floating]:absolute');
  });

  it('floats unconditionally ("always"), not just for single-branch messages', () => {
    // Unlike AssistantActionBar (whose BranchPicker shares row 2, so a
    // multi-branch message already reserves >= the bar's height there),
    // UserActionBar's BranchPicker lives in a SEPARATE row (row-start-3).
    // Row 2 here only ever holds the bar + the message bubble, so mounting
    // the bar in-flow risks growing row 2 regardless of branch count --
    // "single-branch" would still shift multi-branch user messages.
    const userActionBarStart = userMessageSourceFile.indexOf('export const UserActionBar =');
    expect(userActionBarStart).toBeGreaterThan(-1);
    const userActionBarSource = userMessageSourceFile.slice(userActionBarStart);
    expect(userActionBarSource).toContain('autohideFloat="always"');
  });

  it('anchors the floating bar to a relative message root', () => {
    const userMessageStart = userMessageSourceFile.indexOf('const UserMessage = ()');
    const userActionBarStart = userMessageSourceFile.indexOf('export const UserActionBar =');
    expect(userMessageStart).toBeGreaterThan(-1);
    expect(userActionBarStart).toBeGreaterThan(userMessageStart);
    const userMessageSource = userMessageSourceFile.slice(userMessageStart, userActionBarStart);
    // The primary (non-approval-chip) MessagePrimitive.Root that mounts
    // UserActionBar must be `relative` so the absolutely-positioned bar's
    // containing block is its own grid area, not some ancestor further up
    // the tree (matches AssistantMessage's existing `relative grid`).
    const rootClassName = userMessageSource.match(
      /<MessagePrimitive\.Root\s+className="(aui-user-message-root [^"]*)"[^>]*>\s*<UserActionBar\s*\/>/u
    )?.[1];
    expect(rootClassName).toBeDefined();
    // Animation utilities may sort between these tokens; their order has no
    // effect on the root's containing block or grid layout.
    expect(rootClassName?.split(/\s+/u)).toEqual(
      expect.arrayContaining(['aui-user-message-root', 'relative', 'grid'])
    );
  });
});
