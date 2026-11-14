/**
 * ADR-0040: one project's memory folder, `<data root>/project-memory/<project
 * id>/`, and the only code that writes it. It runs Anthropic's memory tool
 * commands with the vendor's result strings, keeps `MEMORY.md` from the note
 * files after every change, keeps which notes untrusted context wrote, and
 * refuses a note that looks like it holds a secret.
 */
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HostMemoryChange, HostMemoryNote, HostMemoryRefusal } from '@brainstrike/agent-host';
import { refusalError, ToolInputError } from '@brainstrike/assistant-contract';
import {
  MEMORY_NOTE_MAX_CHARS,
  type MemoryInput,
} from '@brainstrike/assistant-contract/native-tool-schemas';
import { PROJECT_MEMORY_DIR } from '@brainstrike/state-store';
import { scrubLikelySecretValues } from '@brainstrike/utils/diagnostics';
import {
  ensureContainedDirectory,
  resolveWorkspaceWritePath,
} from '../native-tools/secure-file-write.ts';
import { resolveWorkspaceAbsolutePath } from '../native-tools/workspace-path-resolution.ts';
import { memoryIndexLine, memoryNoteStem, memoryNoteTitle } from './memory-index.ts';
import {
  MEMORY_INDEX_FILE,
  memoryRelativePath,
  memoryToolPath,
  namesMemoryIndex,
} from './memory-paths.ts';

/** Which notes untrusted context wrote, kept by the host beside them and hidden from the tool. */
const PROVENANCE_FILE = '.provenance.json';
const PROJECT_ID = /^[\w-]+$/u;

/** A project's memory folder under the data root. */
export function projectMemoryFolder(dataRoot: string, projectId: string): string {
  if (!PROJECT_ID.test(projectId)) {
    throw new Error(`A project id is one path segment; got ${JSON.stringify(projectId)}`);
  }
  return path.join(dataRoot, PROJECT_MEMORY_DIR, projectId);
}

/** Remove a deleted project's memory folder (ADR-0040). */
export async function removeProjectMemory(dataRoot: string, projectId: string): Promise<void> {
  await rm(projectMemoryFolder(dataRoot, projectId), { force: true, recursive: true });
}

/** A note the host refused to store: the card shows `refusal`, the model the message. */
export class ProjectMemoryRefusal extends ToolInputError {
  readonly refusal: HostMemoryRefusal;

  constructor(refusal: HostMemoryRefusal, message: string) {
    super(message);
    this.name = 'ProjectMemoryRefusal';
    this.refusal = refusal;
  }
}

export interface ProjectMemoryResult {
  readonly change?: HostMemoryChange;
  readonly output: string;
}

/** Writes to one folder run one at a time, whichever thread's call they come from. */
const folderQueues = new Map<string, Promise<unknown>>();
function serialize<T>(folder: string, task: () => Promise<T>): Promise<T> {
  const previous = folderQueues.get(folder) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  folderQueues.set(folder, settled);
  void settled.then(() => {
    if (folderQueues.get(folder) === settled) {
      folderQueues.delete(folder);
    }
  });
  return next;
}

function errorCode(cause: unknown): string | undefined {
  return cause instanceof Error && 'code' in cause ? String(cause.code) : undefined;
}

function humanSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)}K`
    : `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function numbered(text: string, first = 1): string {
  return text
    .split('\n')
    .map((line, index) => `${String(index + first).padStart(6, ' ')}\t${line}`)
    .join('\n');
}

function lineNumbersOf(text: string, needle: string): number[] {
  const lines: number[] = [];
  let at = text.indexOf(needle);
  while (at !== -1) {
    lines.push(text.slice(0, at).split('\n').length);
    at = text.indexOf(needle, at + 1);
  }
  return lines;
}

function missing(toolPath: string): ToolInputError {
  return new ToolInputError(`Error: The path ${toolPath} does not exist`);
}

function indexIsTheHosts(): ToolInputError {
  return new ToolInputError(
    `Error: ${memoryToolPath(MEMORY_INDEX_FILE)} is kept by the app from the notes. Write a note instead.`
  );
}

export class ProjectMemoryNotes {
  readonly folder: string;
  readonly projectId: string;

  constructor(dataRoot: string, projectId: string) {
    this.folder = projectMemoryFolder(dataRoot, projectId);
    this.projectId = projectId;
  }

  /**
   * The project's notes for a run admitted to it, its folder made. Only the
   * project's deletion removes the folder, so a run admitted before it finds
   * none and is refused rather than bringing it back.
   */
  static async open(dataRoot: string, projectId: string): Promise<ProjectMemoryNotes> {
    const notes = new ProjectMemoryNotes(dataRoot, projectId);
    await mkdir(notes.folder, { recursive: true });
    return notes;
  }

  /** `MEMORY.md` as the host last wrote it; undefined while the project has no notes. */
  async readIndex(): Promise<string | undefined> {
    try {
      return await readFile(path.join(this.folder, MEMORY_INDEX_FILE), 'utf8');
    } catch (cause) {
      if (errorCode(cause) === 'ENOENT') {
        return;
      }
      throw cause;
    }
  }

  /** One memory tool call. A write returns the change Core commits. */
  execute(
    input: MemoryInput,
    provenance: { readonly untrusted: boolean }
  ): Promise<ProjectMemoryResult> {
    if (input.command === 'view') {
      return this.view(required(input.path, 'path'), input.view_range ?? undefined);
    }
    return serialize(this.folder, () => this.write(input, provenance.untrusted ? 'add' : 'keep'));
  }

  /** BST-2534: every note, by path, for the project's Memory panel. */
  list(): Promise<HostMemoryNote[]> {
    return serialize(this.folder, async () => {
      const marks = await this.readMarks();
      return await Promise.all((await this.notes('')).map((note) => this.listed(note, marks)));
    });
  }

  /**
   * BST-2534: a person's note, its whole text. It replaces the note at `path`, or makes one named
   * from its first line. A person's own write is trusted, so it clears the note's mark.
   */
  save(note: {
    readonly path?: string | undefined;
    readonly text: string;
  }): Promise<HostMemoryNote> {
    return serialize(this.folder, async () => {
      const toolPath = note.path ?? memoryToolPath(await this.unusedName(note.text));
      await this.write({ command: 'create', ['file_text']: note.text, path: toolPath }, 'clear');
      return await this.listed(memoryRelativePath(toolPath), new Set());
    });
  }

  private async listed(relative: string, marks: ReadonlySet<string>): Promise<HostMemoryNote> {
    const text = (await this.readNote(relative)) ?? '';
    return {
      modifiedAt: (await lstat(await this.existing(relative))).mtimeMs,
      path: memoryToolPath(relative),
      text,
      title: memoryNoteTitle(relative, text),
      untrusted: marks.has(relative),
    };
  }

  /** A new note's file name, from its first line, beside the notes already there. */
  private async unusedName(text: string): Promise<string> {
    const stem = memoryNoteStem(text);
    for (let copy = 1; ; copy += 1) {
      const name = copy === 1 ? `${stem}.md` : `${stem}-${copy}.md`;
      if (!namesMemoryIndex(name) && (await this.kind(name)) === undefined) {
        return name;
      }
    }
  }

  /** Restore what one committed write replaced; refused once the note changed since. */
  undo(change: HostMemoryChange): Promise<void> {
    return serialize(this.folder, async () => {
      if (!(await this.folderExists())) {
        throw refusalError(
          'conflict',
          'memory.project-gone',
          "This note's project no longer exists, so nothing was undone."
        );
      }
      const marks = await this.readMarks();
      await (change.fromPath === undefined
        ? this.restore(change, marks)
        : this.moveBack(change, change.fromPath, marks));
      await this.settle(marks);
    });
  }

  /** Put back the text a write replaced, or delete the note it made. */
  private async restore(change: HostMemoryChange, marks: Set<string>): Promise<void> {
    const at = memoryRelativePath(change.path);
    if (change.text === null && change.previous === null) {
      throw refusalError(
        'conflict',
        'memory.nothing-to-undo',
        'A deleted folder cannot be restored.'
      );
    }
    if ((await this.readNote(at)) !== change.text) {
      throw changedSince();
    }
    if (change.previous === null) {
      await rm(await this.writable(at), { force: true });
      marks.delete(at);
      return;
    }
    await writeFile(await this.writable(at), change.previous, 'utf8');
    if (change.untrusted) {
      marks.add(at);
    }
  }

  /**
   * Move a renamed note back, while it still holds what the rename left (a
   * renamed directory: while it is there) and nothing took its old place.
   */
  private async moveBack(
    change: HostMemoryChange,
    fromPath: string,
    marks: Set<string>
  ): Promise<void> {
    const at = memoryRelativePath(change.path);
    const from = memoryRelativePath(fromPath);
    const unchanged =
      change.text === null
        ? (await this.kind(at)) === 'directory'
        : (await this.readNote(at)) === change.text;
    if (!unchanged || (await this.kind(from)) !== undefined) {
      throw changedSince();
    }
    await this.move(at, from, marks);
  }

  private async view(
    toolPath: string,
    range: readonly number[] | undefined
  ): Promise<ProjectMemoryResult> {
    const relative = memoryRelativePath(toolPath);
    await this.requireFolder();
    const kind = await this.kind(relative);
    if (kind === undefined) {
      return { output: `The path ${toolPath} does not exist. Please provide a valid path.` };
    }
    if (kind === 'directory') {
      const entries = await this.listing(relative);
      return {
        output: [
          `Here're the files and directories up to 2 levels deep in ${memoryToolPath(relative)}, excluding hidden items and node_modules:`,
          ...entries,
        ].join('\n'),
      };
    }
    const text = (await this.readNote(relative)) ?? '';
    const lines = text.replace(/\n$/u, '').split('\n');
    const first = range?.[0] ?? 1;
    const last = range?.[1] === undefined || range[1] === -1 ? lines.length : range[1];
    if (first < 1 || first > Math.max(lines.length, 1) || last < first) {
      throw new ToolInputError(
        `Error: Invalid \`view_range\`: [${first}, ${last}]. The note has ${lines.length} lines.`
      );
    }
    let shown = numbered(lines.slice(first - 1, last).join('\n'), first);
    if (shown.length > MEMORY_NOTE_MAX_CHARS) {
      shown = `${shown.slice(0, MEMORY_NOTE_MAX_CHARS)}\n[cut at ${MEMORY_NOTE_MAX_CHARS} characters; view a range to read on]`;
    }
    return {
      output: `Here's the content of ${memoryToolPath(relative)} with line numbers:\n${shown}`,
    };
  }

  /**
   * A write, and what it does to the note's untrusted mark: a write from untrusted context adds
   * it, any other run's write keeps it, and a person's own write clears it.
   */
  private async write(
    input: MemoryInput,
    mark: 'add' | 'clear' | 'keep'
  ): Promise<ProjectMemoryResult> {
    await this.requireFolder();
    const marks = await this.readMarks();
    if (input.command === 'rename') {
      return await this.renameNote(
        required(input.old_path, 'old_path'),
        required(input.new_path, 'new_path'),
        marks,
        mark === 'add'
      );
    }
    const toolPath = required(input.path, 'path');
    const relative = memoryRelativePath(toolPath);
    if (namesMemoryIndex(relative)) {
      throw indexIsTheHosts();
    }
    if (relative === '') {
      throw new ToolInputError(`Error: ${toolPath} is the memory directory itself.`);
    }
    if (input.command === 'delete') {
      return await this.deleteNote(toolPath, relative, marks);
    }
    const previous = await this.readNote(relative);
    let text: string;
    let output: string;
    switch (input.command) {
      case 'create':
        text = required(input.file_text, 'file_text');
        output = `File created successfully at: ${toolPath}`;
        break;
      case 'str_replace': {
        if (previous === null) {
          throw new ToolInputError(
            `Error: The path ${toolPath} does not exist. Please provide a valid path.`
          );
        }
        const oldStr = required(input.old_str, 'old_str');
        const found = lineNumbersOf(previous, oldStr);
        if (found.length === 0) {
          throw new ToolInputError(
            `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${toolPath}.`
          );
        }
        if (found.length > 1) {
          throw new ToolInputError(
            `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${found.join(', ')}. Please ensure it is unique`
          );
        }
        text = previous.replace(oldStr, () => input.new_str ?? '');
        output = `The memory file has been edited.\n${numbered(text.replace(/\n$/u, ''))}`;
        break;
      }
      case 'insert': {
        if (previous === null) {
          throw missing(toolPath);
        }
        const lines = previous.split('\n');
        const at = required(input.insert_line, 'insert_line');
        if (at < 0 || at > lines.length) {
          throw new ToolInputError(
            `Error: Invalid \`insert_line\` parameter: ${at}. It should be within the range of lines of the file: [0, ${lines.length}]`
          );
        }
        lines.splice(at, 0, required(input.insert_text, 'insert_text').replace(/\n$/u, ''));
        text = lines.join('\n');
        output = `The file ${toolPath} has been edited.`;
        break;
      }
      default:
        throw new ToolInputError(`Error: unknown command ${input.command}`);
    }
    this.admit(toolPath, relative, text);
    await writeFile(await this.writable(relative), text, 'utf8');
    if (mark === 'add') {
      marks.add(relative);
    } else if (mark === 'clear') {
      marks.delete(relative);
    }
    await this.settle(marks);
    return {
      change: {
        path: memoryToolPath(relative),
        previous,
        projectId: this.projectId,
        text,
        title: memoryNoteTitle(relative, text),
        untrusted: marks.has(relative),
      },
      output,
    };
  }

  /** A note is stored only within the size limit and with nothing that looks like a secret. */
  private admit(toolPath: string, relative: string, text: string): void {
    if (text.length > MEMORY_NOTE_MAX_CHARS) {
      throw new ToolInputError(
        `Error: A note holds at most ${MEMORY_NOTE_MAX_CHARS} characters; ${toolPath} would hold ${text.length}.`
      );
    }
    const scan = scrubLikelySecretValues(text);
    if (scan.redactedCount > 0) {
      const kinds = scan.kinds.join(', ');
      throw new ProjectMemoryRefusal(
        {
          path: memoryToolPath(relative),
          projectId: this.projectId,
          reason: `Holds a secret (${kinds})`,
          title: memoryNoteTitle(relative, scan.text),
        },
        `Error: Not saved: ${toolPath} holds what looks like a secret (${kinds}). Never save secrets to memory.`
      );
    }
  }

  private async deleteNote(
    toolPath: string,
    relative: string,
    marks: Set<string>
  ): Promise<ProjectMemoryResult> {
    const kind = await this.kind(relative);
    if (kind === undefined) {
      throw missing(toolPath);
    }
    const previous = kind === 'file' ? await this.readNote(relative) : null;
    const untrusted = marks.has(relative);
    await rm(await this.writable(relative), { force: true, recursive: true });
    for (const mark of [...marks]) {
      if (mark === relative || mark.startsWith(`${relative}/`)) {
        marks.delete(mark);
      }
    }
    await this.settle(marks);
    return {
      change: {
        path: memoryToolPath(relative),
        previous,
        projectId: this.projectId,
        text: null,
        title:
          previous === null ? path.posix.basename(relative) : memoryNoteTitle(relative, previous),
        untrusted,
      },
      output: `Successfully deleted ${toolPath}`,
    };
  }

  private async renameNote(
    oldPath: string,
    newPath: string,
    marks: Set<string>,
    untrusted: boolean
  ): Promise<ProjectMemoryResult> {
    const from = memoryRelativePath(oldPath);
    const to = memoryRelativePath(newPath);
    if (namesMemoryIndex(from) || namesMemoryIndex(to)) {
      throw indexIsTheHosts();
    }
    if (from === '' || to === '') {
      throw new ToolInputError(`Error: ${memoryToolPath('')} is the memory directory itself.`);
    }
    const kind = await this.kind(from);
    if (kind === undefined) {
      throw missing(oldPath);
    }
    if ((await this.kind(to)) !== undefined) {
      throw new ToolInputError(`Error: The destination ${newPath} already exists`);
    }
    await this.move(from, to, marks);
    const moved = kind === 'file' ? [to] : await this.notes(to);
    if (untrusted) {
      for (const note of moved) {
        marks.add(note);
      }
    }
    await this.settle(marks);
    const text = kind === 'file' ? await this.readNote(to) : null;
    return {
      change: {
        fromPath: memoryToolPath(from),
        path: memoryToolPath(to),
        previous: null,
        projectId: this.projectId,
        text,
        title: text === null ? path.posix.basename(to) : memoryNoteTitle(to, text),
        untrusted: moved.some((note) => marks.has(note)),
      },
      output: `Successfully renamed ${oldPath} to ${newPath}`,
    };
  }

  private async move(from: string, to: string, marks: Set<string>): Promise<void> {
    const source = await this.existing(from);
    await rename(source, await this.writable(to));
    for (const mark of [...marks]) {
      if (mark === from || mark.startsWith(`${from}/`)) {
        marks.delete(mark);
        marks.add(`${to}${mark.slice(from.length)}`);
      }
    }
  }

  /** Write the marks and the index from the notes now on disk. */
  private async settle(marks: Set<string>): Promise<void> {
    const notes = await this.notes('');
    const kept = [...marks].filter((mark) => notes.includes(mark)).sort();
    const provenance = path.join(this.folder, PROVENANCE_FILE);
    if (kept.length === 0) {
      await rm(provenance, { force: true });
    } else {
      await writeFile(provenance, `${JSON.stringify({ untrusted: kept })}\n`, 'utf8');
    }
    const lines = await Promise.all(
      notes.map(async (note) =>
        memoryIndexLine(note, (await this.readNote(note)) ?? '', kept.includes(note))
      )
    );
    const index = path.join(this.folder, MEMORY_INDEX_FILE);
    if (lines.length === 0) {
      await rm(index, { force: true });
    } else {
      await writeFile(index, `${lines.join('\n')}\n`, 'utf8');
    }
  }

  private async readMarks(): Promise<Set<string>> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(path.join(this.folder, PROVENANCE_FILE), 'utf8')
      );
      const untrusted =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { untrusted?: unknown }).untrusted
          : undefined;
      if (!(Array.isArray(untrusted) && untrusted.every((entry) => typeof entry === 'string'))) {
        throw new Error(`Project memory provenance is unreadable: ${this.folder}`);
      }
      return new Set(untrusted);
    } catch (cause) {
      if (errorCode(cause) === 'ENOENT') {
        return new Set();
      }
      throw cause;
    }
  }

  /** Every note under `relative`, by its path under the folder, sorted; the index is not one. */
  private async notes(relative: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await this.entries(directory)) {
        const child = directory === '' ? entry.name : `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(child);
        } else if (entry.isFile() && child !== MEMORY_INDEX_FILE) {
          found.push(child);
        }
      }
    };
    await walk(relative);
    return found.sort();
  }

  /** A directory's entries the vendor's listing shows: no hidden item, no node_modules. */
  private async entries(directory: string): Promise<import('node:fs').Dirent[]> {
    try {
      const entries = await readdir(path.join(this.folder, directory), { withFileTypes: true });
      return entries
        .filter(
          (entry) => !(entry.name.startsWith('.') || entry.name.toLowerCase() === 'node_modules')
        )
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (cause) {
      if (errorCode(cause) === 'ENOENT') {
        return [];
      }
      throw cause;
    }
  }

  /** The vendor's listing: sizes and paths, two levels deep, hidden items left out. */
  private async listing(relative: string): Promise<string[]> {
    const lines: string[] = [];
    const sizeOf = async (child: string): Promise<number> => {
      const info = await lstat(path.join(this.folder, child));
      if (!info.isDirectory()) {
        return info.size;
      }
      const inside = await this.notes(child);
      const sizes = await Promise.all(
        inside.map(async (note) => (await lstat(path.join(this.folder, note))).size)
      );
      return sizes.reduce((sum, size) => sum + size, 0);
    };
    const visit = async (directory: string, depth: number): Promise<void> => {
      lines.push(`${humanSize(await sizeOf(directory))}\t${memoryToolPath(directory)}`);
      if (depth === 2) {
        return;
      }
      for (const entry of await this.entries(directory)) {
        const child = directory === '' ? entry.name : `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
          await visit(child, depth + 1);
        } else {
          lines.push(`${humanSize(await sizeOf(child))}\t${memoryToolPath(child)}`);
        }
      }
    };
    await visit(relative, 0);
    return lines;
  }

  private async kind(relative: string): Promise<'directory' | 'file' | undefined> {
    try {
      const resolved = await resolveWorkspaceAbsolutePath(this.folder, `/${relative}`);
      return (await lstat(resolved.absolutePath)).isDirectory() ? 'directory' : 'file';
    } catch (cause) {
      if (errorCode(cause) === 'ENOENT') {
        return;
      }
      throw cause;
    }
  }

  /** A note's text, or null when there is no file there. */
  private async readNote(relative: string): Promise<string | null> {
    if ((await this.kind(relative)) !== 'file') {
      return null;
    }
    return await readFile(await this.existing(relative), 'utf8');
  }

  private async folderExists(): Promise<boolean> {
    try {
      return (await stat(this.folder)).isDirectory();
    } catch (cause) {
      if (errorCode(cause) === 'ENOENT') {
        return false;
      }
      throw cause;
    }
  }

  /** The project's folder, which only the project's deletion removes once a run was admitted. */
  private async requireFolder(): Promise<void> {
    if (!(await this.folderExists())) {
      throw new ToolInputError(
        "Error: This thread's project no longer exists, so its memory was not read or changed."
      );
    }
  }

  private async existing(relative: string): Promise<string> {
    return (await resolveWorkspaceAbsolutePath(this.folder, `/${relative}`)).absolutePath;
  }

  /** Where a write to `relative` goes, inside the folder through every symlink, its folders made. */
  private async writable(relative: string): Promise<string> {
    const resolved = await resolveWorkspaceWritePath(this.folder, relative);
    await ensureContainedDirectory(resolved.canonicalRootPath, path.dirname(resolved.absolutePath));
    return resolved.absolutePath;
  }
}

function changedSince(): Error {
  return refusalError(
    'conflict',
    'memory.changed-since',
    'This note changed after the save, so it was not undone.'
  );
}

function required<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined) {
    throw new ToolInputError(`Error: \`${field}\` is required for this command.`);
  }
  return value;
}
