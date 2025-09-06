import { Terminal, X } from 'lucide-react';
import type React from 'react';
import { type ImperativePanelHandle, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '../button';

interface ConsolePanelProps {
  panelRef: React.RefObject<ImperativePanelHandle | null>;
  content: React.ReactNode;
  hideButtonRef: React.RefObject<HTMLButtonElement | null>;
  onHide: () => void;
  defaultSize: number;
  onCollapse: () => void;
  onExpand: (size?: number) => void;
}

export function ConsolePanel({
  panelRef,
  content,
  hideButtonRef,
  onHide,
  defaultSize,
  onCollapse,
  onExpand,
}: ConsolePanelProps) {
  return (
    <>
      <PanelResizeHandle className="h-1 bg-border hover:bg-border/80 transition-colors" />
      <Panel
        ref={panelRef}
        id="console-panel"
        data-panel-id="console-panel"
        order={2}
        defaultSize={defaultSize}
        minSize={15}
        maxSize={80}
        collapsible
        collapsedSize={0}
        onCollapse={onCollapse}
        onExpand={onExpand}
        className="bg-background"
      >
        <div className="h-full border-t border-border">
          <div className="flex items-center justify-between p-2 border-b border-border bg-muted/30">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4" />
              <span className="text-sm font-medium">File Editor</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onHide}
              aria-label="Close File Editor"
              data-testid="hide-console-panel"
              ref={hideButtonRef}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="h-[calc(100%-2.5rem)] overflow-auto">{content}</div>
        </div>
      </Panel>
    </>
  );
}
