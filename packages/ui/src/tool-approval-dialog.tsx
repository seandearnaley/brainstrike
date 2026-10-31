/**
 * Tool Approval Dialog
 *
 * Confirmation dialog shown before executing mutation tools that require user approval.
 * Displays tool information and input parameters for user review.
 */

import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from './button';
import { Checkbox } from './checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Label } from './label';
import { cn } from './lib/utils';
import { ScrollArea } from './scroll-area';

/**
 * Tool information for the approval dialog.
 */
export interface ToolApprovalInfo {
  /** Category of the tool */
  category?: string;
  /** Description of what the tool does */
  description: string;
  /** Tool identifier */
  id: string;
  /** Input parameters being passed to the tool */
  input: Record<string, unknown>;
  /** Human-readable tool name */
  name: string;
  /** Estimated impact or risk level */
  riskLevel?: 'low' | 'medium' | 'high';
}

/**
 * Result of the approval dialog.
 */
export interface ToolApprovalResult {
  /** Whether the user approved the action */
  approved: boolean;
  /** Whether to skip approval for this tool in the future */
  dontAskAgain: boolean;
}

export interface ToolApprovalDialogProps {
  /** Optional: custom description */
  description?: string;
  /** Called when the dialog is closed (approved or cancelled) */
  onResult: (result: ToolApprovalResult) => void;
  /** Whether the dialog is open */
  open: boolean;
  /** Optional: whether to show the "don't ask again" checkbox */
  showDontAskAgain?: boolean;
  /** Optional: custom title */
  title?: string;
  /** Tool information to display */
  tool: ToolApprovalInfo;
}

/**
 * Format a value for display in the parameters list.
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value.length > 100 ? `${value.slice(0, 100)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

/**
 * Get risk level styling.
 */
function getRiskLevelStyle(level: 'low' | 'medium' | 'high' | undefined): string {
  switch (level) {
    case 'high':
      return 'text-destructive';
    case 'medium':
      return 'text-warning';
    default:
      // 'low' and undefined both get muted foreground style
      return 'text-muted-foreground';
  }
}

/**
 * Tool Approval Dialog Component
 */
export function ToolApprovalDialog({
  open,
  tool,
  onResult,
  title,
  description,
  showDontAskAgain = true,
}: ToolApprovalDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false);

  const handleApprove = () => {
    onResult({ approved: true, dontAskAgain });
  };

  const handleCancel = () => {
    onResult({ approved: false, dontAskAgain: false });
  };

  const inputEntries = Object.entries(tool.input);
  const hasInput = inputEntries.length > 0;
  const isHighRisk = tool.riskLevel === 'high';

  return (
    <Dialog onOpenChange={(isOpen) => !isOpen && handleCancel()} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isHighRisk && <AlertTriangle className="text-destructive h-5 w-5" />}
            {title ?? 'Confirm Tool Action'}
          </DialogTitle>
          <DialogDescription>
            {description ?? 'This action requires your approval before proceeding.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Tool Info */}
          <div className="bg-muted/30 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <code className="font-mono text-sm">{tool.id}</code>
              {tool.category && (
                <span className="bg-muted text-muted-foreground rounded px-2 py-0.5 text-xs">
                  {tool.category}
                </span>
              )}
            </div>
            <p className="text-muted-foreground mt-1 text-sm">{tool.description}</p>
            {tool.riskLevel && (
              <p className={cn('mt-1 text-xs', getRiskLevelStyle(tool.riskLevel))}>
                Risk level: {tool.riskLevel}
              </p>
            )}
          </div>

          {/* Input Parameters */}
          {hasInput && (
            <div className="space-y-2">
              <p className="text-sm leading-none font-medium">Parameters</p>
              <ScrollArea className="h-[150px] rounded-md border">
                <div className="space-y-2 p-3">
                  {inputEntries.map(([key, value]) => (
                    <div className="space-y-1" key={key}>
                      <div className="text-muted-foreground font-mono text-xs">{key}</div>
                      <pre className="bg-muted/50 rounded p-2 font-mono text-xs break-words whitespace-pre-wrap">
                        {formatValue(value)}
                      </pre>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Don't Ask Again */}
          {showDontAskAgain && (
            <div className="flex items-center space-x-2">
              <Checkbox
                checked={dontAskAgain}
                id="dont-ask-again"
                onCheckedChange={(checked) => setDontAskAgain(checked === true)}
              />
              <Label className="text-sm" htmlFor="dont-ask-again">
                Don't ask again for this tool
              </Label>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={handleCancel} variant="outline">
            Cancel
          </Button>
          <Button onClick={handleApprove} variant={isHighRisk ? 'destructive' : 'default'}>
            {isHighRisk ? 'Proceed Anyway' : 'Approve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Hook for managing tool approval state.
 */
export interface UseToolApprovalOptions {
  /** Called when a tool is approved */
  onApprove?: (toolId: string, dontAskAgain: boolean) => void;
  /** Called when a tool is cancelled */
  onCancel?: (toolId: string) => void;
  /** Tools that have been marked as "don't ask again" */
  skipApprovalFor?: Set<string>;
}

export interface UseToolApprovalResult {
  /** Clear the pending approval */
  clearPending: () => void;
  /** Whether approval is pending */
  isPending: boolean;
  /** Currently pending tool (if any) */
  pendingTool: ToolApprovalInfo | null;
  /** Request approval for a tool */
  requestApproval: (tool: ToolApprovalInfo) => Promise<ToolApprovalResult>;
  /** Resolve the pending approval with a result */
  resolvePending: (result: ToolApprovalResult) => void;
}

/**
 * Hook for managing tool approval workflow.
 */
export function useToolApproval(options: UseToolApprovalOptions = {}): UseToolApprovalResult {
  const { onApprove, onCancel, skipApprovalFor } = options;
  const [pendingTool, setPendingTool] = useState<ToolApprovalInfo | null>(null);
  const pendingRef = useRef<ToolApprovalInfo | null>(null);
  const resolveRef = useRef<((result: ToolApprovalResult) => void) | null>(null);
  const queueRef = useRef<
    Array<{ tool: ToolApprovalInfo; resolve: (result: ToolApprovalResult) => void }>
  >([]);

  const onApproveRef = useRef(onApprove);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onApproveRef.current = onApprove;
  }, [onApprove]);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  const startApproval = (tool: ToolApprovalInfo, resolve: (result: ToolApprovalResult) => void) => {
    pendingRef.current = tool;
    resolveRef.current = (result: ToolApprovalResult) => {
      if (result.approved) {
        onApproveRef.current?.(tool.id, result.dontAskAgain);
      } else {
        onCancelRef.current?.(tool.id);
      }

      resolve(result);

      const next = queueRef.current.shift();
      if (next) {
        // Use the resolve callback pattern via queueRef to avoid self-reference
        const nextResolveRef = next.resolve;
        const nextTool = next.tool;
        pendingRef.current = nextTool;
        resolveRef.current = (nextResult: ToolApprovalResult) => {
          if (nextResult.approved) {
            onApproveRef.current?.(nextTool.id, nextResult.dontAskAgain);
          } else {
            onCancelRef.current?.(nextTool.id);
          }
          nextResolveRef(nextResult);
          pendingRef.current = null;
          resolveRef.current = null;
          setPendingTool(null);
        };
        setPendingTool(nextTool);
        return;
      }

      pendingRef.current = null;
      resolveRef.current = null;
      setPendingTool(null);
    };

    setPendingTool(tool);
  };

  const requestApproval = async (tool: ToolApprovalInfo): Promise<ToolApprovalResult> => {
    // Check if we should skip approval for this tool
    if (skipApprovalFor?.has(tool.id)) {
      return { approved: true, dontAskAgain: true };
    }

    return new Promise((resolve) => {
      if (pendingRef.current) {
        queueRef.current.push({ resolve, tool });
        return;
      }

      startApproval(tool, resolve);
    });
  };

  const resolvePending = (result: ToolApprovalResult) => {
    resolveRef.current?.(result);
  };

  const clearPending = () => {
    resolvePending({ approved: false, dontAskAgain: false });
  };

  return {
    clearPending,
    isPending: pendingTool !== null,
    pendingTool,
    requestApproval,
    resolvePending,
  };
}

export default ToolApprovalDialog;
