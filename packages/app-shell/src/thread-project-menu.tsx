/**
 * A project section's menu and rename form in the Threads panel (ADR-0034 build decisions).
 * Rename project… names the project; Move to project… moves the section's folder into another
 * project the panel lists, as the person chooses; Locate folder… points a folder that is not
 * mounted at the place it moved to. A repository found inside an open folder (BST-2511) is named
 * and moved like any project's folder, and its first name or move makes its project (BST-2520);
 * it is not an open folder, so it is never located. The changes are the host's
 * (`thread-project-actions.ts`).
 */
import { Button, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import {
  ArrowLeft,
  Check,
  FolderInput,
  FolderSearch,
  MoreHorizontal,
  Pencil,
  X,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { useState } from 'react';
import type { ThreadProjectFolder, ThreadProjectRef } from './assistant-thread-host-context';
import { THREAD_CONTROL_ACTION_CLASS_NAME } from './assistant-thread-presentation';
import type { ThreadProjectActions } from './thread-project-actions';

/** The project a section stands for, and the folder its actions act on. */
export interface ThreadSectionProject {
  /** The folder the section is named by: the one Move to project… moves. */
  readonly folder: ThreadProjectFolder;
  readonly folderName: string;
  /** The section's name as the panel shows it. */
  readonly label: string;
  /**
   * The root of an open folder that is not mounted, so it may have moved and can be located;
   * null for any other, a repository found inside an open folder included.
   */
  readonly locateRootId: string | null;
  /** The name the person gave the project, or null. */
  readonly name: string | null;
  /** Null for a repository found inside an open folder that has no project yet. */
  readonly projectId: string | null;
  /** What Rename project… names: the project, or the repository whose first name makes it. */
  readonly target: ThreadProjectRef;
}

const MENU_ITEM_CLASS_NAME = 'h-8 justify-start gap-2 px-2 text-xs';

export function ThreadProjectMenu({
  actions,
  onRenameStart,
  project,
}: {
  readonly actions: ThreadProjectActions;
  readonly onRenameStart: () => void;
  readonly project: ThreadSectionProject;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const others = actions.listed.filter((choice) => choice.projectId !== project.projectId);
  const { locate } = actions;
  const { locateRootId } = project;
  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setChoosing(false);
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          aria-label={`Project actions ${project.label}`}
          className={THREAD_CONTROL_ACTION_CLASS_NAME}
          data-testid="thread-project-actions"
          onClick={(event) => event.stopPropagation()}
          size="icon-xs"
          title={`Project actions ${project.label}`}
          type="button"
          variant="ghost"
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className={choosing ? 'w-64 p-2' : 'w-48 p-1.5'}
        collisionPadding={8}
        onClick={(event) => event.stopPropagation()}
      >
        {choosing ? (
          <div className="grid gap-1.5" data-testid="thread-project-move-list">
            <div className="flex items-center gap-1.5">
              <Button
                aria-label="Back to project actions"
                onClick={() => setChoosing(false)}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <ArrowLeft className="size-3.5" />
              </Button>
              <div className="text-xs font-medium">Move {project.folderName} to project</div>
            </div>
            <p className="text-muted-foreground text-2xs px-1">
              Its threads list with the project you choose. Its trust and approved hooks stay its
              own.
            </p>
            {others.length === 0 ? (
              <p className="text-muted-foreground text-2xs px-1">No other project is listed.</p>
            ) : (
              others.map((choice) => (
                <Button
                  className={MENU_ITEM_CLASS_NAME}
                  key={choice.projectId}
                  onClick={() => {
                    setOpen(false);
                    setChoosing(false);
                    // Never rejects: a refusal resolves false, and the panel says why.
                    void actions.join(project.folder, choice.projectId);
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <FolderInput className="size-3.5" />
                  <span className="min-w-0 truncate">{choice.label}</span>
                </Button>
              ))
            )}
          </div>
        ) : (
          <div className="grid gap-0.5">
            <Button
              className={MENU_ITEM_CLASS_NAME}
              onClick={() => {
                setOpen(false);
                onRenameStart();
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Pencil className="size-3.5" />
              Rename project…
            </Button>
            <Button
              className={MENU_ITEM_CLASS_NAME}
              onClick={() => setChoosing(true)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <FolderInput className="size-3.5" />
              Move to project…
            </Button>
            {locateRootId !== null && locate ? (
              <Button
                className={MENU_ITEM_CLASS_NAME}
                onClick={() => {
                  setOpen(false);
                  // Never rejects: a refusal resolves false, and the panel says why.
                  void locate(locateRootId);
                }}
                size="sm"
                title={`Choose where ${project.folderName} is now, if it moved`}
                type="button"
                variant="ghost"
              >
                <FolderSearch className="size-3.5" />
                Locate folder…
              </Button>
            ) : null}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Names the project in place of the section's label. Empty clears the name, so the project is
 * named by its folder again; the host trims it and refuses one too long.
 */
export function ThreadProjectRenameForm({
  onDone,
  onRename,
  project,
}: {
  readonly onDone: () => void;
  readonly onRename: (name: string) => Promise<boolean>;
  readonly project: ThreadSectionProject;
}): ReactElement {
  const [draft, setDraft] = useState(project.name ?? '');
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1"
      data-testid="thread-project-rename-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        // `onRename` never rejects: a refusal resolves false, and the panel says why.
        void onRename(draft)
          .then((renamed) => {
            // A refusal keeps the form open with the name as typed.
            if (renamed) {
              onDone();
            }
          })
          .finally(() => setSaving(false));
      }}
    >
      <input
        aria-label="Project name"
        autoFocus
        className="border-border bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-2 py-0.5 text-xs leading-4 outline-hidden focus-visible:ring-2"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onDone();
          }
        }}
        placeholder={project.folderName}
        value={draft}
      />
      <Button
        aria-label="Save project name"
        disabled={saving}
        size="icon-xs"
        type="submit"
        variant="ghost"
      >
        <Check className="size-3.5" />
      </Button>
      <Button
        aria-label="Cancel project rename"
        onClick={onDone}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <X className="size-3.5" />
      </Button>
    </form>
  );
}
