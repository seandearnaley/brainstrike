/**
 * User-invocable Agent Skills for the composer's "/" menu.
 *
 * Desktop-only by construction: on web `window.skills` is absent and this
 * returns an empty list (capability gating, never `isElectron()`). Each entry
 * is a namespaced `skill:<name>` slash command whose `execute` stages a
 * VISIBLE `:skill[name]` directive into the composer draft (trigger text
 * stripped, existing draft preserved) — the user sees and can edit or remove
 * the directive before sending, and the desktop assistant server resolves it
 * into the skill's full instructions at the request boundary. NO auto-send,
 * no silent expansion (the same contract as user-defined /commands).
 *
 * Only skills that are `status: 'ok'`, spec `user-invocable` (default true),
 * AND enabled in the skills preferences store are offered; the master toggle
 * empties the menu entirely.
 */

import {
  type SkillScanEntrySummary,
  type SkillsScanResultSummary,
  serializeSkillDirective,
} from '@brainstrike/assistant-contract';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import { useSkillsPreferencesStore } from '@brainstrike/preferences/stores/skills-preferences-store';
import { useToast } from '@brainstrike/ui';
import type { SlashCommand } from '@brainstrike/ui/assistant-ui-panel';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';

const logger = createLogger('SkillSlashCommands');

type SkillToast = (input: { description: string; title: string; variant: 'destructive' }) => void;

const EMPTY_RESULT: SkillsScanResultSummary = { entries: [] };

type SkillsBridge = () => Promise<SkillsScanResultSummary>;

/** Resolve the desktop skills bridge, or `null` on web (no preload). */
function resolveSkillsBridge(): SkillsBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = window.skills;
  if (!bridge) {
    return null;
  }
  if (typeof bridge.scan !== 'function') {
    logger.error('window.skills bridge is malformed; skill slash commands disabled', {
      hasScan: typeof bridge.scan,
    });
    return null;
  }
  return bridge.scan;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Stage the activation directive: strip the typed `/skill:<name>` trigger from
 * the LIVE draft (the app-shell mirror of assistant-ui's composer state),
 * append the `:skill[name]` directive, and write the result back — never
 * auto-send (the user edits/removes it before sending).
 */
function applySkillCommand(
  entry: SkillScanEntrySummary,
  commandId: string,
  threadId: string | undefined,
  toast: SkillToast
): void {
  const name = entry.name;
  if (!name) {
    return;
  }
  if (!threadId) {
    logger.warn('Cannot stage a skill activation without an active thread', { name });
    toast({
      description: 'Open or start a thread, then invoke the skill again.',
      title: 'No active thread',
      variant: 'destructive',
    });
    return;
  }
  const store = useAssistantComposerCommandStore.getState();
  const draftText = store.draftTextByThreadId[threadId] ?? '';
  const withoutTrigger = draftText
    .replace(new RegExp(`/${escapeRegExp(commandId)}(?:\\s+[\\s\\S]*)?$`), '')
    .trimEnd();
  const directive = serializeSkillDirective(name);
  const text = withoutTrigger.length > 0 ? `${withoutTrigger} ${directive} ` : `${directive} `;
  store.enqueue({ mode: 'replace', text, threadId });
}

/**
 * User-invocable skills as composer slash commands, reloaded on mount, on
 * mounted-root change, and on window visibilitychange (mirrors the
 * user-defined /commands hook, including the monotonic generation guard).
 */
export function useSkillSlashCommands(threadId: string | undefined): readonly SlashCommand[] {
  const bridge = useMemo(resolveSkillsBridge, []);
  const activeRootIds = useFileExplorerStoreSelector((state) => state.activeRootIds);
  const [scan, setScan] = useState<SkillsScanResultSummary>(EMPTY_RESULT);
  const { toast } = useToast();
  const masterEnabled = useSkillsPreferencesStore((state) => state.masterEnabled);
  const disabledSkillKeys = useSkillsPreferencesStore((state) => state.disabledSkillKeys);

  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const generationRef = useRef(0);

  const reload = useCallback(() => {
    if (!bridge) {
      return () => {
        // no-op cleanup when the desktop bridge is absent (web)
      };
    }
    generationRef.current += 1;
    const generation = generationRef.current;
    bridge()
      .then((result) => {
        if (generation === generationRef.current) {
          setScan(result);
        }
      })
      .catch((error: unknown) => {
        logger.error('Failed to load skills for the slash menu', { error });
      });
    return () => {
      generationRef.current += 1;
    };
  }, [bridge]);

  useEffect(() => reload(), [reload, activeRootIds]);

  useEffect(() => {
    if (!bridge || typeof document === 'undefined') {
      return;
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        reload();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [bridge, reload]);

  return useMemo<readonly SlashCommand[]>(() => {
    if (!masterEnabled) {
      return [];
    }
    return scan.entries
      .filter(
        (entry) =>
          entry.status === 'ok' &&
          entry.name !== undefined &&
          entry.userInvocable !== false &&
          !(entry.preferenceKey && disabledSkillKeys[entry.preferenceKey])
      )
      .map((entry) => {
        const commandId = `skill:${entry.name}`;
        return {
          execute: () => {
            applySkillCommand(entry, commandId, threadIdRef.current, toastRef.current);
          },
          id: commandId,
          label: entry.name as string,
          ...(entry.description === undefined ? {} : { description: entry.description }),
        };
      });
  }, [disabledSkillKeys, masterEnabled, scan]);
}
