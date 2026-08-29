import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { McpLabFaultRuntime } from './fault-runtime.js';
import type { McpLabChildExitFault } from './faults.js';

interface ChildControlConfiguration {
  readonly exitArmed: boolean;
  readonly exitCode?: number;
  readonly stderrText?: string;
}

async function waitForChildExit(isChildAlive: () => boolean): Promise<void> {
  const deadline = Date.now() + 2500;
  while (isChildAlive()) {
    if (Date.now() >= deadline) {
      throw new Error('MCP lab stdio child remained alive after cleanup');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

export class McpLabStdioChildFaults {
  private commandSequence = 0;
  private controlDirectory: string | undefined;
  private exitTrigger: Promise<void> | undefined;
  private readonly requiresExitProof: boolean;

  constructor(private readonly runtime: McpLabFaultRuntime) {
    this.requiresExitProof = runtime.hasRemainingPhase('child-process');
  }

  async args(baseArgs: readonly string[]): Promise<readonly string[]> {
    const stderrFault = this.runtime.configuredFault('child-process', 'child/stderr', 1);
    const exitFault = this.runtime.configuredFault('child-process', 'child/exit', 1);
    if (!(stderrFault || exitFault)) {
      return baseArgs;
    }
    if (stderrFault && stderrFault.kind !== 'child_stderr') {
      throw new Error('MCP lab child/stderr fault is not executable');
    }
    if (exitFault && exitFault.kind !== 'child_exit') {
      throw new Error('MCP lab child/exit fault is not executable');
    }
    this.controlDirectory = await mkdtemp(join(tmpdir(), 'brainstrike-mcp-child-'));
    const configuration: ChildControlConfiguration = {
      exitArmed: exitFault !== undefined,
      ...(exitFault?.kind === 'child_exit' && exitFault.code !== null
        ? { exitCode: exitFault.code }
        : {}),
      ...(stderrFault?.kind === 'child_stderr' ? { stderrText: stderrFault.text } : {}),
    };
    const configurationPath = join(this.controlDirectory, 'configuration.json');
    await writeFile(configurationPath, JSON.stringify(configuration), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return Object.freeze([...baseArgs, `--brainstrike-fault-control=${configurationPath}`]);
  }

  async beforeSpawn(): Promise<void> {
    const fault = this.runtime.configuredFault('child-process', 'child/spawn', 1);
    if (!fault) {
      return;
    }
    if (fault.kind !== 'delay') {
      throw new Error('MCP lab child/spawn fault is not executable');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, fault.delayMs));
    this.runtime.consume('child-process', 'child/spawn', 'stdio-reference:child-spawn:1');
  }

  async afterSpawn(): Promise<void> {
    const stderrFault = this.runtime.configuredFault('child-process', 'child/stderr', 1);
    if (stderrFault) {
      await this.sendCommand('stderr');
      this.runtime.consume('child-process', 'child/stderr', 'stdio-reference:child-stderr:1');
    }
    if (this.controlDirectory) {
      await this.sendCommand('start-mcp');
    }
  }

  afterSend(pid: number, isChildAlive: () => boolean, readyForExit: boolean): Promise<void> {
    if (this.exitTrigger) {
      return this.exitTrigger;
    }
    if (!readyForExit) {
      return Promise.resolve();
    }
    const fault = this.runtime.configuredFault('child-process', 'child/exit', 1);
    if (!fault) {
      return Promise.resolve();
    }
    if (fault.kind !== 'child_exit') {
      return Promise.reject(new Error('MCP lab child/exit fault is not executable'));
    }
    const triggering = this.triggerExit(pid, fault, isChildAlive);
    this.exitTrigger = triggering;
    return triggering;
  }

  async close(pid: number | null, isChildAlive: () => boolean = () => false): Promise<void> {
    try {
      if (this.requiresExitProof && pid !== null && isChildAlive()) {
        await waitForChildExit(isChildAlive);
      }
      if (this.controlDirectory) {
        await rm(this.controlDirectory, { force: true, recursive: true });
      }
    } catch {
      throw new Error('MCP lab stdio child cleanup failed');
    }
  }

  private async sendCommand(command: 'exit' | 'start-mcp' | 'stderr'): Promise<void> {
    if (!this.controlDirectory) {
      throw new Error(`MCP lab child ${command} fault has no control channel`);
    }
    this.commandSequence += 1;
    const id = String(this.commandSequence).padStart(6, '0');
    const commandPath = join(this.controlDirectory, `command-${id}-${command}`);
    const acknowledgementPath = join(this.controlDirectory, `ack-${id}`);
    await writeFile(commandPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        await access(acknowledgementPath);
        return;
      } catch {
        if (Date.now() >= deadline) {
          throw new Error(`MCP lab child did not acknowledge ${basename(commandPath)}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    }
  }

  private async triggerExit(
    pid: number,
    fault: McpLabChildExitFault,
    isChildAlive: () => boolean
  ): Promise<void> {
    if (!isChildAlive()) {
      throw new Error('MCP lab stdio child is no longer owned');
    }
    if (fault.signal === null) {
      await this.sendCommand('exit');
    } else {
      process.kill(pid, fault.signal);
    }
    this.runtime.consume('child-process', 'child/exit', 'stdio-reference:child-exit:1');
    await waitForChildExit(isChildAlive);
  }
}
