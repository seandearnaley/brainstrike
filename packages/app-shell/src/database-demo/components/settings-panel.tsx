import type { ChunkingStrategy } from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import type { SettingsPanelProps } from '../types';

const AVAILABLE_MODELS = SimpleEmbeddingService.listModels();

export function SettingsPanel({ importSettings }: SettingsPanelProps) {
  return (
    <div className="mt-2 p-3 bg-muted/50 rounded space-y-3">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs">Chunking</Label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="checkbox"
              checked={importSettings.enableChunking}
              onChange={(e) => importSettings.setEnableChunking(e.target.checked)}
              className="h-3 w-3"
            />
            <Select
              value={importSettings.chunkingStrategy}
              onValueChange={(value) =>
                importSettings.setChunkingStrategy(value as ChunkingStrategy)
              }
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

        <div>
          <Label className="text-xs">Embeddings</Label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="checkbox"
              checked={importSettings.enableEmbedding}
              onChange={(e) => importSettings.setEnableEmbedding(e.target.checked)}
              className="h-3 w-3"
            />
            <Select
              value={importSettings.selectedModel}
              onValueChange={importSettings.setSelectedModel}
            >
              <SelectTrigger className="h-6 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(AVAILABLE_MODELS).map(([key, model]) => (
                  <SelectItem key={key} value={key} className="text-xs">
                    {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs">Chunk Size</Label>
          <Input
            type="number"
            value={importSettings.chunkSize}
            onChange={(e) => importSettings.setChunkSize(Number(e.target.value))}
            className="h-6 text-xs"
            min="128"
            max="2048"
          />
        </div>
        <div>
          <Label className="text-xs">Overlap</Label>
          <Input
            type="number"
            value={importSettings.chunkOverlap}
            onChange={(e) => importSettings.setChunkOverlap(Number(e.target.value))}
            className="h-6 text-xs"
            min="0"
            max="256"
          />
        </div>
      </div>
    </div>
  );
}
