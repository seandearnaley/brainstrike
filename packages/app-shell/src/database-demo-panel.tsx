import type { ChunkingStrategy, FileChunk, FileRecord } from '@brainstrike/db';
import { type FileChunkRepository, useFileRecordRepository } from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import { useFileExplorer, useSelectionManager } from '@brainstrike/file-explorer-ui';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  type ImportProgress,
  ImportProgress as ImportProgressComponent,
  Input,
  Label,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@brainstrike/ui';
import {
  Archive,
  Brain,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  FileText,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  createCSVBlob,
  exportAllDataAsZip,
  generateChunksCSV,
  generateCSVFilename,
  generateEmbeddingsCSV,
  generateFilesWithChunksCSV,
} from './csv-export-utils';
import { useEnhancedFileImportService } from './enhanced-file-import-service';

// Get available models from the embeddings service
const AVAILABLE_MODELS = SimpleEmbeddingService.listModels();
const DEFAULT_MODEL_KEY = SimpleEmbeddingService.getDefaultModelKey();

interface ChunkSearchResult {
  chunk: FileChunk;
  similarity: number;
  fileRecord: FileRecord;
}

// Utility functions
const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDate = (isoString: string): string => {
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
};

// View selector component
interface ViewSelectorProps {
  selectedView: 'files' | 'chunks' | 'search';
  setSelectedView: (view: 'files' | 'chunks' | 'search') => void;
  recordsCount: number;
  chunksCount: number;
}

function ViewSelector({
  selectedView,
  setSelectedView,
  recordsCount,
  chunksCount,
}: ViewSelectorProps) {
  return (
    <div className="flex gap-2 pt-2 mb-3">
      <Button
        size="sm"
        variant={selectedView === 'files' ? 'default' : 'outline'}
        onClick={() => setSelectedView('files')}
      >
        Files ({recordsCount})
      </Button>
      <Button
        size="sm"
        variant={selectedView === 'chunks' ? 'default' : 'outline'}
        onClick={() => setSelectedView('chunks')}
      >
        Chunks ({chunksCount})
      </Button>
      <Button
        size="sm"
        variant={selectedView === 'search' ? 'default' : 'outline'}
        onClick={() => setSelectedView('search')}
      >
        Search
      </Button>
    </div>
  );
}

// Database info component
interface DbInfoDisplayProps {
  dbInfo: {
    location: string;
    testResult: string;
    connected: boolean;
  } | null;
}

function DbInfoDisplay({ dbInfo }: DbInfoDisplayProps) {
  if (!dbInfo) return null;

  return (
    <div className="mt-2 p-2 bg-muted rounded text-xs">
      <div className="font-medium">Storage: {dbInfo.location}</div>
      <div className={`mt-1 ${dbInfo.connected ? 'text-green-600' : 'text-red-600'}`}>
        {dbInfo.connected ? '✓' : '✗'} {dbInfo.testResult}
      </div>
    </div>
  );
}

// Enhanced import result interface matching the one from enhanced-file-import-service
interface EnhancedImportResult {
  id: string;
  imported: boolean;
  existed: boolean;
  error?: string;
  chunksCreated: number;
  chunksWithEmbeddings?: number;
}

// Enhanced progress interface matching the one from enhanced-file-import-service
interface EnhancedImportProgress extends ImportProgress {
  phase: 'importing' | 'chunking' | 'embedding' | 'complete';
  chunkingProgress?: {
    filesProcessed: number;
    totalFiles: number;
    currentFile?: string | undefined;
    chunksCreated: number;
  };
  embeddingProgress?: {
    chunksProcessed: number;
    totalChunks: number;
    currentChunk?: string | undefined;
    modelName: string;
  };
}

// Component for import progress display
interface ImportProgressDisplayProps {
  progress: EnhancedImportProgress;
  onClose: () => void;
}

// Settings panel component
interface SettingsPanelProps {
  importSettings: ReturnType<typeof useImportSettings>;
}

// Export buttons component
interface ExportButtonsProps {
  records: FileRecord[];
  chunks: FileChunk[];
  exportHandlers: ReturnType<typeof useExportHandlers>;
}

// Search interface component
interface SearchInterfaceProps {
  searchFunctionality: ReturnType<typeof useSearchFunctionality>;
}

function SearchInterface({ searchFunctionality }: SearchInterfaceProps) {
  return (
    <div className="mt-4 space-y-2">
      <div className="flex gap-2">
        <Input
          placeholder="Search in file chunks..."
          value={searchFunctionality.searchQuery}
          onChange={(e) => searchFunctionality.setSearchQuery(e.target.value)}
          className="flex-1 h-8 text-xs"
          onKeyDown={(e) => e.key === 'Enter' && searchFunctionality.handleSearch()}
        />
        <Button
          size="sm"
          onClick={searchFunctionality.handleSearch}
          disabled={searchFunctionality.searching || !searchFunctionality.searchQuery.trim()}
          className="flex items-center gap-1"
        >
          <Search className="h-3 w-3" />
          {searchFunctionality.searching ? 'Searching...' : 'Search'}
        </Button>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <Label>Threshold:</Label>
        <Input
          type="number"
          value={searchFunctionality.searchThreshold}
          onChange={(e) => searchFunctionality.setSearchThreshold(Number(e.target.value))}
          className="w-20 h-6"
          min="0"
          max="1"
          step="0.1"
        />
      </div>
    </div>
  );
}

function ExportButtons({ records, chunks, exportHandlers }: ExportButtonsProps) {
  return (
    <div className="flex gap-2 pt-2">
      <Button
        size="sm"
        variant="outline"
        onClick={exportHandlers.handleExportFiles}
        disabled={records.length === 0}
        className="flex items-center gap-1"
      >
        <Download className="h-3 w-3" />
        Files ({records.length})
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={exportHandlers.handleExportChunks}
        disabled={chunks.length === 0}
        className="flex items-center gap-1"
      >
        <Download className="h-3 w-3" />
        Chunks ({chunks.length})
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={exportHandlers.handleExportEmbeddings}
        disabled={chunks.filter((c) => c.embedding).length === 0}
        className="flex items-center gap-1"
      >
        <Brain className="h-3 w-3" />
        Embeddings ({chunks.filter((c) => c.embedding).length})
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={exportHandlers.handleExportAll}
        disabled={records.length === 0 && chunks.length === 0}
        className="flex items-center gap-1"
      >
        <Archive className="h-3 w-3" />
        All (ZIP)
      </Button>
    </div>
  );
}

function SettingsPanel({ importSettings }: SettingsPanelProps) {
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

function ImportProgressDisplay({ progress, onClose }: ImportProgressDisplayProps) {
  return (
    <>
      <ImportProgressComponent progress={progress} onClose={onClose} />
      {progress.phase === 'chunking' && progress.chunkingProgress && (
        <div className="mt-2 p-2 bg-blue-50 rounded text-xs">
          <div className="flex justify-between items-center">
            <span>Chunking: {progress.chunkingProgress.currentFile}</span>
            <span>
              {progress.chunkingProgress.filesProcessed}/{progress.chunkingProgress.totalFiles}
            </span>
          </div>
          <Progress
            value={
              (progress.chunkingProgress.filesProcessed / progress.chunkingProgress.totalFiles) *
              100
            }
            className="h-1 mt-1"
          />
          <div className="text-muted-foreground mt-1">
            {progress.chunkingProgress.chunksCreated} chunks created
          </div>
        </div>
      )}
      {progress.phase === 'embedding' && progress.embeddingProgress && (
        <div className="mt-2 p-2 bg-purple-50 rounded text-xs">
          <div className="flex justify-between items-center">
            <span>Embedding: {progress.embeddingProgress.currentChunk}</span>
            <span>
              {progress.embeddingProgress.chunksProcessed}/{progress.embeddingProgress.totalChunks}
            </span>
          </div>
          <Progress
            value={
              (progress.embeddingProgress.chunksProcessed /
                progress.embeddingProgress.totalChunks) *
              100
            }
            className="h-1 mt-1"
          />
          <div className="text-muted-foreground mt-1">
            Using {progress.embeddingProgress.modelName}
          </div>
        </div>
      )}
    </>
  );
}

// Custom hook for managing import settings
function useImportSettings() {
  const [enableChunking, setEnableChunking] = useState(true);
  const [chunkingStrategy, setChunkingStrategy] = useState<ChunkingStrategy>('sentence');
  const [chunkSize, setChunkSize] = useState(500); // Appropriate size for code chunking
  const [chunkOverlap, setChunkOverlap] = useState(50); // 10% overlap
  const [enableEmbedding, setEnableEmbedding] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL_KEY);

  return {
    enableChunking,
    setEnableChunking,
    chunkingStrategy,
    setChunkingStrategy,
    chunkSize,
    setChunkSize,
    chunkOverlap,
    setChunkOverlap,
    enableEmbedding,
    setEnableEmbedding,
    selectedModel,
    setSelectedModel,
  };
}

// Custom hook for managing search functionality
function useSearchFunctionality(
  embeddingService: SimpleEmbeddingService | null,
  chunkRepository: FileChunkRepository | null,
  repository: ReturnType<typeof useFileRecordRepository>,
  selectedModel: string,
  toast: ReturnType<typeof useToast>['toast']
) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ChunkSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchThreshold, setSearchThreshold] = useState(0.5);

  const enrichChunkResults = useCallback(
    async (chunkResults: Array<{ chunk: FileChunk; similarity: number }>) => {
      const results: ChunkSearchResult[] = [];
      for (const chunkResult of chunkResults) {
        const fileRecord = await repository?.findById(chunkResult.chunk.fileRecordId);
        if (fileRecord) {
          results.push({
            chunk: chunkResult.chunk,
            similarity: chunkResult.similarity,
            fileRecord,
          });
        }
      }
      return results;
    },
    [repository]
  );

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim() || !embeddingService || !chunkRepository) {
      return;
    }

    setSearching(true);
    try {
      const status = embeddingService.getStatus();
      if (status !== 'ready') {
        await embeddingService.initializeWithModel(selectedModel);
      }

      const queryEmbedding = await embeddingService.generateEmbedding(searchQuery);
      const chunkResults = await chunkRepository.searchSimilar(queryEmbedding.embedding, {
        limit: 20,
        threshold: searchThreshold,
      });

      const results = await enrichChunkResults(chunkResults);
      setSearchResults(results);
    } catch (error) {
      toast({
        title: 'Search Failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSearching(false);
    }
  }, [
    searchQuery,
    embeddingService,
    chunkRepository,
    selectedModel,
    searchThreshold,
    enrichChunkResults,
    toast,
  ]);

  return {
    searchQuery,
    setSearchQuery,
    searchResults,
    searching,
    searchThreshold,
    setSearchThreshold,
    handleSearch,
  };
}

// Custom hook for export functionality
function useExportHandlers(
  records: FileRecord[],
  chunks: FileChunk[],
  toast: ReturnType<typeof useToast>['toast']
) {
  const handleExportFiles = useCallback(() => {
    if (records.length === 0) {
      toast({
        title: 'No Data to Export',
        description: 'Import some files first before exporting.',
        variant: 'destructive',
      });
      return;
    }

    try {
      const csvContent = generateFilesWithChunksCSV(records);
      const blob = createCSVBlob(csvContent);
      const filename = generateCSVFilename('files');

      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      toast({
        title: 'Export Successful',
        description: `Exported ${records.length} files to ${filename}`,
      });
    } catch (error) {
      toast({
        title: 'Export Failed',
        description: error instanceof Error ? error.message : 'Failed to export files',
        variant: 'destructive',
      });
    }
  }, [records, toast]);

  const handleExportChunks = useCallback(() => {
    if (chunks.length === 0) {
      toast({
        title: 'No Chunks to Export',
        description: 'Process some files with chunking enabled first.',
        variant: 'destructive',
      });
      return;
    }

    try {
      const csvContent = generateChunksCSV(chunks);
      const blob = createCSVBlob(csvContent);
      const filename = generateCSVFilename('chunks');

      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      toast({
        title: 'Export Successful',
        description: `Exported ${chunks.length} chunks to ${filename}`,
      });
    } catch (error) {
      toast({
        title: 'Export Failed',
        description: error instanceof Error ? error.message : 'Failed to export chunks',
        variant: 'destructive',
      });
    }
  }, [chunks, toast]);

  const handleExportEmbeddings = useCallback(() => {
    const chunksWithEmbeddings = chunks.filter((chunk) => chunk.embedding);
    if (chunksWithEmbeddings.length === 0) {
      toast({
        title: 'No Embeddings to Export',
        description: 'Generate embeddings for chunks first.',
        variant: 'destructive',
      });
      return;
    }

    try {
      const csvContent = generateEmbeddingsCSV(chunks);
      const blob = createCSVBlob(csvContent);
      const filename = generateCSVFilename('embeddings');

      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      toast({
        title: 'Export Successful',
        description: `Exported ${chunksWithEmbeddings.length} embeddings to ${filename}`,
      });
    } catch (error) {
      toast({
        title: 'Export Failed',
        description: error instanceof Error ? error.message : 'Failed to export embeddings',
        variant: 'destructive',
      });
    }
  }, [chunks, toast]);

  const handleExportAll = useCallback(async () => {
    if (records.length === 0 && chunks.length === 0) {
      toast({
        title: 'No Data to Export',
        description: 'Import some files first before exporting.',
        variant: 'destructive',
      });
      return;
    }

    try {
      await exportAllDataAsZip(records, chunks);
      toast({
        title: 'Export Successful',
        description: 'All data exported as ZIP archive',
      });
    } catch (error) {
      toast({
        title: 'Export Failed',
        description: error instanceof Error ? error.message : 'Failed to export all data',
        variant: 'destructive',
      });
    }
  }, [records, chunks, toast]);

  return {
    handleExportFiles,
    handleExportChunks,
    handleExportEmbeddings,
    handleExportAll,
  };
}

// Helper function for import completion
function createImportCompletionHandler(
  toast: ReturnType<typeof useToast>['toast'],
  loadRecords: () => Promise<void>,
  loadChunks: () => Promise<void>
) {
  return (results: EnhancedImportResult[]) => {
    const imported = results.filter((r) => r.imported).length;
    const importFailed = results.filter((r) => !r.imported).length;
    const processingErrors = results.filter((r) => r.imported && r.error).length;
    const totalChunks = results.reduce((acc, r) => acc + (r.chunksCreated || 0), 0);
    const totalEmbeddings = results.reduce((acc, r) => acc + (r.chunksWithEmbeddings || 0), 0);

    let description = `${imported} files imported`;
    if (importFailed > 0) {
      description += `, ${importFailed} import failed`;
    }
    if (processingErrors > 0) {
      description += `, ${processingErrors} processing errors`;
    }
    if (totalChunks > 0) {
      description += `, ${totalChunks} chunks created`;
    }
    if (totalEmbeddings > 0) {
      description += `, ${totalEmbeddings} embeddings generated`;
    }

    toast({
      title: 'Import Complete',
      description,
      variant: importFailed > 0 ? 'destructive' : processingErrors > 0 ? 'default' : 'default',
    });

    // Refresh the records to show new imports
    void loadRecords();
    void loadChunks();
  };
}

export function DatabaseDemoPanel() {
  const repository = useFileRecordRepository();
  const { toast } = useToast();
  const [records, setRecords] = useState<FileRecord[]>([]);
  const [chunks, setChunks] = useState<FileChunk[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showImportProgress, setShowImportProgress] = useState(false);
  const [selectedView, setSelectedView] = useState<'files' | 'chunks' | 'search'>('files');
  const [dbInfo, setDbInfo] = useState<{
    location: string;
    testResult: string;
    connected: boolean;
  } | null>(null);

  // Use custom hooks
  const importSettings = useImportSettings();
  const [embeddingService, setEmbeddingService] = useState<SimpleEmbeddingService | null>(null);

  // UI state
  const [showSettings, setShowSettings] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  // Access file explorer context
  const { fileContents, fileTree } = useFileExplorer();
  const { selectedFilePaths } = useSelectionManager({
    onSelectionLimitExceeded: () => {
      toast({
        title: 'Selection Limit Reached',
        description: 'You have reached the maximum number of files that can be selected.',
        variant: 'destructive',
      });
    },
  });

  // Export handlers
  const exportHandlers = useExportHandlers(records, chunks, toast);

  // Enhanced file import service
  const { isImporting, progress, importFiles, chunkRepository } = useEnhancedFileImportService({
    onProgress: () => {
      setShowImportProgress(true);
    },
    onComplete: (results) => {
      const handler = createImportCompletionHandler(
        toast,
        () => loadRecords(),
        () => {
          if (chunkRepository) {
            return loadChunks();
          }
          return Promise.resolve();
        }
      );
      handler(results);
    },
    onError: (error) => {
      toast({
        title: 'Import Failed',
        description: error.message,
        variant: 'destructive',
      });
    },
    enableChunking: importSettings.enableChunking,
    chunkingStrategy: importSettings.chunkingStrategy,
    enableEmbedding: importSettings.enableEmbedding,
    embeddingModel: importSettings.selectedModel,
    chunkSize: importSettings.chunkSize,
    chunkOverlap: importSettings.chunkOverlap,
  });

  // Initialize embedding service - start with WASM device for better stability
  useEffect(() => {
    if (importSettings.enableEmbedding && importSettings.selectedModel) {
      const service = new SimpleEmbeddingService();
      setEmbeddingService(service);

      // Cleanup on unmount or when settings change
      return () => {
        service.dispose();
      };
    }
    // Return empty cleanup function when service is not created
    return () => {};
  }, [importSettings.enableEmbedding, importSettings.selectedModel]);

  const loadRecords = useCallback(async () => {
    if (!repository) return;

    try {
      setRefreshing(true);
      const importedRecords =
        (await repository.findAllWithContent?.()) || (await repository.findAll());
      setRecords(importedRecords);
    } catch (_error) {
      toast({
        title: 'Error',
        description: 'Failed to load database records',
        variant: 'destructive',
      });
    } finally {
      setRefreshing(false);
    }
  }, [repository, toast]);

  const loadChunks = useCallback(async () => {
    if (!chunkRepository) return;

    try {
      const allChunks = await chunkRepository.findAll();
      setChunks(allChunks);
    } catch (error) {
      // Only show error toast if it's not a pgvector-related error
      const errorMessage = error instanceof Error ? error.message : '';
      if (!errorMessage.includes('vector') && !errorMessage.includes('chunks')) {
        toast({
          title: 'Error',
          description: 'Failed to load chunks',
          variant: 'destructive',
        });
      }
      // Silently fail for pgvector-related errors - just set empty chunks
      setChunks([]);
    }
  }, [chunkRepository, toast]);

  const testDatabaseConnection = useCallback(async () => {
    if (!repository) {
      setDbInfo({
        location: 'Unknown',
        testResult: 'Repository not available',
        connected: false,
      });
      return;
    }

    try {
      // Test database connection using repository directly
      const testResult = await repository.count();
      setDbInfo({
        location: 'Database connected via DbProvider',
        testResult: `Successfully connected - ${testResult} file records found`,
        connected: true,
      });
    } catch (error) {
      setDbInfo({
        location: 'Unknown',
        testResult: `Database connection failed: ${error}`,
        connected: false,
      });
    }
  }, [repository]);

  useEffect(() => {
    if (repository) {
      void loadRecords();
      void testDatabaseConnection();
    }
    if (chunkRepository) {
      void loadChunks();
    }
  }, [repository, chunkRepository, loadRecords, loadChunks, testDatabaseConnection]);

  const handleImportClick = useCallback(() => {
    if (selectedFilePaths.size === 0) {
      toast({
        title: 'No Files Selected',
        description: 'Please select files in the explorer before importing.',
        variant: 'destructive',
      });
      return;
    }

    importFiles(selectedFilePaths, fileTree, fileContents);
  }, [selectedFilePaths, fileTree, fileContents, importFiles, toast]);

  // Use real search functionality once chunkRepository is available
  const realSearchFunctionality = useSearchFunctionality(
    embeddingService,
    chunkRepository,
    repository,
    importSettings.selectedModel,
    toast
  );

  // The export handlers are now managed by the custom hook

  const toggleFileExpansion = (fileId: string) => {
    setExpandedFiles((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(fileId)) {
        newSet.delete(fileId);
      } else {
        newSet.add(fileId);
      }
      return newSet;
    });
  };

  const getFileChunks = useCallback(
    (fileId: string) => chunks.filter((chunk) => chunk.fileRecordId === fileId),
    [chunks]
  );

  if (!repository) {
    return (
      <Card className="h-full">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Database className="h-4 w-4" />
            Enhanced Database Demo
          </CardTitle>
          <CardDescription className="text-xs">Database is initializing...</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-32">
          <div className="text-sm text-muted-foreground">Loading PGlite database...</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="h-full flex flex-col" data-testid="database-demo-panel">
      <div className="p-4 border-b flex-shrink-0">
        <div className="text-sm font-medium flex items-center gap-2 mb-1">
          <Database className="h-4 w-4" />
          Enhanced Database Demo
        </div>
        <div className="text-xs text-muted-foreground mb-3">
          PGlite WASM with pgvector, chunking, and embeddings
        </div>

        <DbInfoDisplay dbInfo={dbInfo} />

        {/* View Selector */}
        <ViewSelector
          selectedView={selectedView}
          setSelectedView={setSelectedView}
          recordsCount={records.length}
          chunksCount={chunks.length}
        />

        {/* Settings Panel */}
        <div className="mb-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowSettings(!showSettings)}
            className="h-6 px-2"
          >
            {showSettings ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Import Settings
          </Button>

          {showSettings && <SettingsPanel importSettings={importSettings} />}
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 pt-2">
          <Button
            size="sm"
            onClick={handleImportClick}
            disabled={isImporting}
            className="flex items-center gap-1"
          >
            <FileText className="h-3 w-3" />
            Import Selected Files ({selectedFilePaths.size})
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void loadRecords();
              if (chunkRepository) void loadChunks();
            }}
            disabled={refreshing}
            className="flex items-center gap-1"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Export Buttons */}
        <ExportButtons records={records} chunks={chunks} exportHandlers={exportHandlers} />

        {/* Search Interface */}
        {selectedView === 'search' && (
          <SearchInterface searchFunctionality={realSearchFunctionality} />
        )}

        {showImportProgress && progress && (
          <div className="mt-4">
            <ImportProgressDisplay
              progress={progress}
              onClose={() => setShowImportProgress(false)}
            />
          </div>
        )}
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-auto min-h-0">
        {selectedView === 'files' && (
          <div className="p-4 h-full">
            {records.length === 0 ? (
              <div className="text-center text-sm text-muted-foreground">
                No files imported yet. Select files and click "Import Selected Files" to get
                started.
              </div>
            ) : (
              <div className="space-y-2 max-h-full overflow-y-auto">
                {records.map((record) => (
                  <div key={record.id} className="border rounded p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleFileExpansion(record.id)}
                          className="h-6 w-6 p-0"
                        >
                          {expandedFiles.has(record.id) ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                        </Button>
                        <span className="font-mono text-sm">{record.name}</span>
                        <Badge variant="secondary" className="text-xs">
                          {formatFileSize(record.size)}
                        </Badge>
                        {record.chunksCount && (
                          <Badge variant="outline" className="text-xs">
                            {record.chunksCount} chunks
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {record.processedAt
                          ? formatDate(record.processedAt)
                          : formatDate(record.createdAt)}
                      </div>
                    </div>

                    {expandedFiles.has(record.id) && (
                      <div className="mt-3 space-y-2">
                        <div className="text-xs text-muted-foreground">Path: {record.path}</div>
                        {record.chunkingStrategy && (
                          <div className="text-xs text-muted-foreground">
                            Chunking: {record.chunkingStrategy} • {record.chunksCount} chunks
                          </div>
                        )}

                        {/* Show chunks for this file */}
                        {getFileChunks(record.id).length > 0 && (
                          <div className="mt-2">
                            <div className="text-xs font-medium mb-1">Chunks:</div>
                            <div className="space-y-1 max-h-40 overflow-y-auto">
                              {getFileChunks(record.id).map((chunk) => (
                                <div key={chunk.id} className="p-2 bg-muted/50 rounded text-xs">
                                  <div className="flex justify-between items-start mb-1">
                                    <Badge variant="outline" className="text-xs">
                                      {chunk.chunkType} #{chunk.chunkIndex}
                                    </Badge>
                                    <div className="flex gap-1">
                                      <Badge variant="secondary" className="text-xs">
                                        {chunk.tokenCount} tokens
                                      </Badge>
                                      {chunk.embedding && (
                                        <Badge variant="default" className="text-xs">
                                          <Brain className="h-2 w-2 mr-1" />
                                          embedded
                                        </Badge>
                                      )}
                                    </div>
                                  </div>
                                  <div className="text-muted-foreground">
                                    {chunk.content.substring(0, 200)}
                                    {chunk.content.length > 200 && '...'}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {selectedView === 'chunks' && (
          <div className="p-4 h-full">
            {chunks.length === 0 ? (
              <div className="text-center text-sm text-muted-foreground">
                No chunks available. Enable chunking in import settings and import some files.
              </div>
            ) : (
              <div className="space-y-2 max-h-full overflow-y-auto">
                {chunks.map((chunk) => (
                  <div key={chunk.id} className="border rounded p-3">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex gap-2">
                        <Badge variant="outline" className="text-xs">
                          {chunk.chunkType} #{chunk.chunkIndex}
                        </Badge>
                        <Badge variant="secondary" className="text-xs">
                          {chunk.tokenCount} tokens
                        </Badge>
                        {chunk.embedding && (
                          <Badge variant="default" className="text-xs">
                            <Brain className="h-2 w-2 mr-1" />
                            embedded
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatDate(chunk.createdAt)}
                      </div>
                    </div>
                    <div className="text-sm text-muted-foreground mb-2">
                      {chunk.content.substring(0, 300)}
                      {chunk.content.length > 300 && '...'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      File: {records.find((r) => r.id === chunk.fileRecordId)?.name || 'Unknown'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {selectedView === 'search' && (
          <div className="p-4 h-full">
            {realSearchFunctionality.searchResults.length === 0 ? (
              <div className="text-center text-sm text-muted-foreground">
                {realSearchFunctionality.searchQuery
                  ? 'No matching chunks found. Try adjusting your search query or threshold.'
                  : 'Enter a search query to find similar content.'}
              </div>
            ) : (
              <div className="space-y-2 max-h-full overflow-y-auto">
                {realSearchFunctionality.searchResults.map((result, index) => (
                  <div key={result.chunk.id} className="border rounded p-3">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex gap-2">
                        <Badge variant="default" className="text-xs">
                          {(result.similarity * 100).toFixed(1)}% match
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {result.chunk.chunkType} #{result.chunk.chunkIndex}
                        </Badge>
                        <Badge variant="secondary" className="text-xs">
                          {result.chunk.tokenCount} tokens
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">#{index + 1}</div>
                    </div>
                    <div className="text-sm mb-2">
                      {result.chunk.content.substring(0, 400)}
                      {result.chunk.content.length > 400 && '...'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      From: {result.fileRecord.name} • {result.fileRecord.path}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
