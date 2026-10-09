/**
 * BST-1932: the desktop host's delegation capability. The personas and limits
 * come from the same preferences and persona files the shipped assistant used
 * (request-personas.ts and user-personas-loader.ts, A26-A28): built-ins plus
 * each mounted root's and the home `.brainstrike/agents/` personas, less the
 * user's disabled ones, under the user's subagent settings. HostCore builds
 * and dispatches the `agent-<persona>` tools from it.
 */
import { homedir } from 'node:os';
import type { HostDelegation } from '@brainstrike/agent-host';
import {
  type AssistantPersonaDefinition,
  BUILT_IN_PERSONAS,
  parseRuntimeSubagentSettings,
  type RuntimeWorkspaceRoot,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { createNodeFsScanDeps } from '../assistant-server/node-fs-scan-deps';
import { scanUserPersonas } from '../assistant-server/user-personas-loader';
import type { UserSlashCommandScanRoot } from '../assistant-server/user-slash-commands-loader';
import type { PlatformSubagentsIntent } from './platform-wire';

const logger = createLogger('DesktopHostDelegation');

export interface DesktopPersonaScan {
  scan(input: { readonly roots: readonly UserSlashCommandScanRoot[] }): {
    readonly personas: readonly AssistantPersonaDefinition[];
  };
}

/** The real persona files under each mounted root and the home directory. */
export const desktopPersonaScan: DesktopPersonaScan = {
  scan: ({ roots }) => {
    const fs = createNodeFsScanDeps();
    try {
      return scanUserPersonas({ homeDir: homedir(), roots }, fs);
    } finally {
      fs.dispose();
    }
  },
};

export function resolveDesktopHostDelegation(
  intent: { readonly subagents?: PlatformSubagentsIntent | undefined },
  provider: string,
  roots: readonly RuntimeWorkspaceRoot[],
  /** A plan-mode run only reads and proposes a plan; it never delegates. */
  planMode: boolean,
  personas: DesktopPersonaScan = desktopPersonaScan
): HostDelegation | undefined {
  const subagents = intent.subagents;
  // A26: the master switch off, plan mode, or the built-in local provider leaves no delegation tools.
  if (!subagents?.delegationEnabled || planMode || provider === 'local') {
    return;
  }
  let scanned: readonly AssistantPersonaDefinition[] = [];
  try {
    scanned = personas.scan({
      roots: roots.map((root) => ({
        absPath: root.path,
        displayName: root.displayName,
        id: root.rootId,
      })),
    }).personas;
  } catch (cause) {
    // A27: a broken agents directory must not take down chat.
    logger.warn('User persona scan failed; continuing with built-in personas only', {
      code: 'host_user_persona_scan_failed',
      errorName: cause instanceof Error ? cause.name : typeof cause,
    });
  }
  const disabled = new Set(subagents.disabledPersonaIds);
  return {
    personas: [...BUILT_IN_PERSONAS, ...scanned].filter((persona) => !disabled.has(persona.id)),
    settings: parseRuntimeSubagentSettings(subagents.settings),
  };
}
