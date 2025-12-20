import type { ChunkingStrategy, FileChunk, FileRecord } from '@brainstrike/db';
import { tokenPreferencesSelectors, useTokenPreferencesStore } from '@brainstrike/preferences';
import {
  Badge,
  Button,
  cn,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import { Trash2 } from 'lucide-react';
import type { SettingsPanelProps } from '../types';

interface ExtendedSettingsPanelProps extends SettingsPanelProps {
  /** Clear database dialog controls - optional for backwards compatibility */
  clearDatabaseProps?: {
    clearAllData: (() => Promise<unknown>) | null;
    records: FileRecord[];
    chunks: FileChunk[];
    clearing: boolean;
    showClearDialog: boolean;
    setShowClearDialog: (show: boolean) => void;
    onClear: () => void;
  };
}

export function SettingsPanel({
  importSettings,
  clearDatabaseProps,
  className,
}: ExtendedSettingsPanelProps) {
  const chunkingId = 'enable-chunking';
  const presetCaps = ['2048', '4096', '6144', '8192'];
  const selectedPreset = presetCaps.includes(String(importSettings.chunkTokenLimit))
    ? String(importSettings.chunkTokenLimit)
    : 'custom';
  const accurateCounting = useTokenPreferencesStore(tokenPreferencesSelectors.accurateCounting);
  return (
    <div className={cn('mt-2 space-y-3 rounded bg-muted/50 p-3', className)}>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs" htmlFor={chunkingId}>
            Chunking
          </Label>
          <div className="mt-1 flex items-center gap-2">
            <input
              checked={importSettings.enableChunking}
              className="h-3 w-3"
              id={chunkingId}
              onChange={(e) => importSettings.setEnableChunking(e.target.checked)}
              type="checkbox"
            />
            <Select
              onValueChange={(value) =>
                importSettings.setChunkingStrategy(value as ChunkingStrategy)
              }
              value={importSettings.chunkingStrategy}
            >
              <SelectTrigger className="h-6 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sentence">Sentence</SelectItem>
                <SelectItem value="token">Token</SelectItem>
                <SelectItem value="recursive">Recursive</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs">Chunk Size</Label>
          <Input
            className="h-6 text-xs"
            max="2048"
            min="128"
            onChange={(e) => importSettings.setChunkSize(Number(e.target.value))}
            type="number"
            value={importSettings.chunkSize}
          />
        </div>
        <div>
          <Label className="text-xs">Overlap</Label>
          <Input
            className="h-6 text-xs"
            max="256"
            min="0"
            onChange={(e) => importSettings.setChunkOverlap(Number(e.target.value))}
            type="number"
            value={importSettings.chunkOverlap}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded border px-3 py-2">
        <div>
          <Label className="text-xs">Token sizing</Label>
          <p className="text-[10px] text-muted-foreground">
            Controlled globally via Settings → Token Counting.
          </p>
        </div>
        <Badge
          className="text-[10px] uppercase"
          variant={accurateCounting ? 'secondary' : 'outline'}
        >
          {accurateCounting ? 'WASM tokenizer' : 'Heuristic mode'}
        </Badge>
      </div>

      <div>
        <Label className="text-xs">Token cap</Label>
        <div className="mt-1 grid grid-cols-2 gap-2">
          <Input
            className="h-6 text-xs"
            max="16384"
            min="512"
            onChange={(e) => importSettings.setChunkTokenLimit(Number(e.target.value) || 0)}
            step="128"
            type="number"
            value={importSettings.chunkTokenLimit}
          />
          <Select
            onValueChange={(value) => {
              if (value === 'custom') {
                return;
              }
              importSettings.setChunkTokenLimit(Number(value));
            }}
            value={selectedPreset}
          >
            <SelectTrigger className="h-6 text-xs">
              <SelectValue placeholder="Presets" />
            </SelectTrigger>
            <SelectContent>
              {presetCaps.map((cap) => (
                <SelectItem className="text-xs" key={cap} value={cap}>
                  {cap} tokens
                </SelectItem>
              ))}
              <SelectItem className="text-xs" value="custom">
                Custom
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Higher caps reduce chunk count at the cost of larger embedding payloads.
        </p>
      </div>

      {/* Clear Database - Dangerous operation, placed at bottom of settings */}
      {clearDatabaseProps && (
        <div className="mt-3 border-border/50 border-t pt-3">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-muted-foreground text-xs">Danger Zone</Label>
              <p className="text-[10px] text-muted-foreground">
                Clear all imported files and chunks from database.
              </p>
            </div>
            <Button
              className="flex h-7 items-center gap-1"
              disabled={
                clearDatabaseProps.clearing ||
                !clearDatabaseProps.clearAllData ||
                (clearDatabaseProps.records.length === 0 && clearDatabaseProps.chunks.length === 0)
              }
              onClick={() => clearDatabaseProps.setShowClearDialog(true)}
              size="sm"
              variant="destructive"
            >
              <Trash2 className="h-3 w-3" />
              Clear Database
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
