import { MessagePartPrimitive } from '@assistant-ui/react';
import { memo, type ReactElement } from 'react';

/**
 * User-authored text parts, shown exactly as typed: plain text with whitespace
 * kept, never markdown (owner decision 2026-10-16; a prompt naming double-star
 * credential globs rendered as bold). Nothing is stripped or normalized, so a pasted
 * citation marker or Nerd Fonts glyph stays as the user sent it. A separate
 * component rather than a role check inside the renderer, so the call sites
 * state plainly which text is normalized and which is not.
 */
export const UserMessageText = memo(function UserMessageText(): ReactElement {
  return (
    <MessagePartPrimitive.Text
      className="whitespace-pre-wrap break-words"
      component="p"
      smooth={false}
    />
  );
});
