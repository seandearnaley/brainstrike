import type { AttachmentAdapter } from '@assistant-ui/react';
import { useMemo } from 'react';
import { createAssistantImageAttachmentAdapter } from './attachment-adapter';

export function useAssistantThreadRuntimeAdapters(
  attachmentsPresent: boolean
): { readonly attachments: AttachmentAdapter } | undefined {
  // Stable adapter instance: recreating it per render would reset composer
  // attachment state. Keyed on availability PRESENCE (not the enabled state,
  // and not the object identity): the adapter must survive an
  // enabled→disabled model switch so attachments staged under a vision model
  // stay removable/sendable — assistant-ui's composer wipes text + staged
  // attachments and then throws an unhandled "Attachments are not supported"
  // rejection if Send runs with no adapter. The 'disabled' vision-gate state
  // blocks NEW adds through the disabled attach button and the absent paste
  // frame (composer-input.tsx) instead; a sent-anyway staged image surfaces
  // the documented visible provider error. Absent availability (provider
  // gate) registers no adapter, so adds are rejected loudly, never silently
  // accepted.
  const attachmentsAdapter = useMemo(
    () => (attachmentsPresent ? createAssistantImageAttachmentAdapter() : undefined),
    [attachmentsPresent]
  );
  return useMemo(
    () => (attachmentsAdapter ? { attachments: attachmentsAdapter } : undefined),
    [attachmentsAdapter]
  );
}
