import { Terminal, X } from 'lucide-react';
import type React from 'react';
import { Panel, type PanelImperativeHandle, Separator } from 'react-resizable-panels';
import { Button } from '../button';

interface ConsolePanelProps {
  content: React.ReactNode;
  defaultSize: number | string;
  hideButtonRef: React.RefObject<HTMLButtonElement | null>;
  onHide: () => void;
  panelRef: React.RefObject<PanelImperativeHandle | null>;
}

export function ConsolePanel({
  panelRef,
  content,
  hideButtonRef,
  onHide,
  defaultSize,
}: ConsolePanelProps) {
  return (
    <>
      <Separator className="z-10 h-1 bg-border transition-colors hover:bg-border/80" />
      <Panel
        className="bg-background"
        collapsedSize="0%"
        collapsible
        data-panel-id="console-panel"
        defaultSize={typeof defaultSize === 'number' ? `${defaultSize}%` : defaultSize}
        id="console-panel"
        maxSize="80%"
        minSize="15%"
        panelRef={panelRef}
      >
        <div className="h-full border-border border-t">
          <div className="flex items-center justify-between border-border border-b bg-muted/30 p-2">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4" />
              <span className="font-medium text-sm">File Editor</span>
            </div>
            <Button
              aria-label="Close File Editor"
              className="h-6 w-6"
              data-testid="hide-console-panel"
              onClick={onHide}
              ref={hideButtonRef}
              size="icon"
              variant="ghost"
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
