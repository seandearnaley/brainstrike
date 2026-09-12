import type { Migration } from './migration-runner.js';

/** Native user input and its admission receipt retain the same bounded image payload. */
export const migration136DelegatedInputPayload: Migration = {
  down: `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM brainstrike_delegated_continuations WHERE input_payload IS NOT NULL
      AND (jsonb_array_length(input_payload->'attachments') > 0
        OR input_payload->>'text' IS DISTINCT FROM input_text OR input_payload ? 'branch'))
    THEN RAISE EXCEPTION 'Cannot discard admitted child input payloads'; END IF;
  END $$;
  ALTER TABLE brainstrike_delegated_continuations DROP CONSTRAINT IF EXISTS brainstrike_delegated_continuations_input_text_check;
  ALTER TABLE brainstrike_delegated_continuations DROP COLUMN IF EXISTS input_payload;
  ALTER TABLE brainstrike_delegated_continuations ADD CONSTRAINT brainstrike_delegated_continuations_input_text_check CHECK (length(btrim(input_text)) > 0);`,
  ledgerKey: 'custom-136-delegated-input-payload',
  name: 'delegated_input_payload',
  up: `ALTER TABLE brainstrike_delegated_continuations ADD COLUMN IF NOT EXISTS input_payload jsonb
    CHECK (input_payload IS NULL OR (jsonb_typeof(input_payload) = 'object' AND jsonb_typeof(input_payload->'attachments') IS NOT DISTINCT FROM 'array'));
  ALTER TABLE brainstrike_delegated_continuations DROP CONSTRAINT IF EXISTS brainstrike_delegated_continuations_input_text_check;
  ALTER TABLE brainstrike_delegated_continuations ADD CONSTRAINT brainstrike_delegated_continuations_input_text_check
    CHECK (length(btrim(input_text)) > 0 OR (input_payload IS NOT NULL AND jsonb_array_length(input_payload->'attachments') > 0));`,
  version: 136,
};
