import { ChevronRight, PanelRight } from 'lucide-react';
import type React from 'react';
import { type ImperativePanelHandle, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '../button';

type RightPanelProps = {
  panelRef: React.RefObject<ImperativePanelHandle | null>;
  content: React.ReactNode;
  hideButtonRef: React.RefObject<HTMLButtonElement | null>;
  onHide: () => void;
  defaultSize: number;
  onCollapse: () => void;
  onExpand: (size?: number) => void;
};

export function RightPanel({
  panelRef,
  content,
  hideButtonRef,
  onHide,
  defaultSize,
  onCollapse,
  onExpand,
}: RightPanelProps) {
  return (
    <>
      <PanelResizeHandle className="w-1 bg-border transition-colors hover:bg-border/80" />
      <Panel
        className="bg-background"
        collapsedSize={0}
        collapsible
        data-panel-id="right-panel"
        defaultSize={defaultSize}
        id="right-panel"
        maxSize={60}
        minSize={15}
        onCollapse={onCollapse}
        onExpand={onExpand}
        order={3}
        ref={panelRef}
      >
        <div className="h-full border-border border-l">
          <div className="flex items-center justify-between border-border border-b bg-muted/30 p-2">
            <div className="flex items-center gap-2">
              <PanelRight className="h-4 w-4" />
              <span className="font-medium text-sm">Panel</span>
            </div>
            <Button
              aria-label="Hide right panel"
              className="h-6 w-6"
              data-testid="hide-right-panel"
              onClick={onHide}
              ref={hideButtonRef}
              size="icon"
              variant="ghost"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex h-[calc(100%-2.5rem)] flex-col overflow-hidden">{content}</div>
        </div>
      </Panel>
    </>
  );
}
