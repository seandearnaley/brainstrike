import { type Orama, create, insertMultiple, search } from '@orama/orama';
import { InfoIcon, RefreshCw } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Progress } from '../../components/ui/progress';
import { ScrollArea } from '../../components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip';

type DocumentType = {
  title: string;
  content: string;
  embedding: number[];
  file: string;
};

// Define the Orama schema: each document has a title, content, embedding (384-d vector), and file ID
const schema = {
  title: 'string',
  content: 'string',
  embedding: 'vector[384]',
  file: 'string',
} as const;

// Dummy embedding generator function; in production, replace with a real model.
async function generateEmbedding(_text: string): Promise<number[]> {
  return new Array(384).fill(0).map(() => Math.random());
}

// Chunk text into overlapping segments to preserve context.
function chunkText(text: string, maxChunkSize = 1000, overlap = 100): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
    if (start < 0) start = 0;
    if (start >= text.length) break;
  }
  return chunks;
}

interface OramaSearchPanelProps {
  // Composite keys for selected files (format: "folderId|@|filePath")
  selectedFiles: Set<string>;
  // Mapping from composite key to file content (text)
  fileContents: { [compositeKey: string]: string };
}

interface SearchResult {
  document: {
    title: string;
    content: string;
    file: string;
  };
  score: number;
}

interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  indexedFiles: string[];
  lastUpdated: Date | null;
}

export const OramaSearchPanel: React.FC<OramaSearchPanelProps> = ({
  selectedFiles,
  fileContents,
}) => {
  const [index, setIndex] = useState<Orama<typeof schema> | null>(null);
  const [isIndexing, setIsIndexing] = useState<boolean>(false);
  const [indexProgress, setIndexProgress] = useState<number>(0);
  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [indexStats, setIndexStats] = useState<IndexStats>({
    totalFiles: 0,
    totalChunks: 0,
    indexedFiles: [],
    lastUpdated: null,
  });
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // Store previous selected files for comparison
  const prevSelectedFilesRef = useRef<Set<string>>(new Set());
  const prevFileContentsRef = useRef<Record<string, string>>({});

  // Check if the index needs to be rebuilt
  const needsReindex = useMemo(() => {
    // If no index exists, we need to build one
    if (!index) return true;

    // If the number of selected files has changed
    if (prevSelectedFilesRef.current.size !== selectedFiles.size) return true;

    // If the selected files have changed
    for (const file of selectedFiles) {
      if (!prevSelectedFilesRef.current.has(file)) return true;

      // If the content of any file has changed
      if (prevFileContentsRef.current[file] !== fileContents[file]) return true;
    }

    return false;
  }, [index, selectedFiles, fileContents]);

  // Build the Orama index from the selected file contents.
  const buildIndex = useCallback(async () => {
    if (selectedFiles.size === 0) {
      setIndex(null);
      setIndexStats({
        totalFiles: 0,
        totalChunks: 0,
        indexedFiles: [],
        lastUpdated: null,
      });
      return;
    }

    setIsIndexing(true);
    setIndexProgress(0);

    // Create a new Orama index instance.
    const db = await create({ schema, id: 'experimental-index' });
    const indexedFiles: string[] = [];
    let totalChunks = 0;
    let processedFiles = 0;

    // Helper function to process in batches with a small delay to avoid blocking the main thread
    const processBatch = async (documents: DocumentType[], batchSize = 100): Promise<void> => {
      const totalBatches = Math.ceil(documents.length / batchSize);
      let processedBatches = 0;

      for (let i = 0; i < documents.length; i += batchSize) {
        const batch = documents.slice(i, i + batchSize);
        await insertMultiple(db, batch);

        // Update progress to show insertion progress (50-100%)
        processedBatches++;
        const insertionProgress = processedBatches / totalBatches;
        // File processing is 0-50%, insertion is 50-100%
        setIndexProgress(50 + Math.floor(insertionProgress * 50));

        // Small delay to allow the main thread to breathe
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    // Collect all documents first
    const allDocuments: DocumentType[] = [];

    // Process each selected file.
    for (const compositeKey of selectedFiles) {
      const content = fileContents[compositeKey];
      if (!content) {
        processedFiles++;
        // File processing is 0-50% of the total progress
        setIndexProgress(Math.floor((processedFiles / selectedFiles.size) * 50));
        continue;
      }

      // Derive a base title from the composite key.
      const parts = compositeKey.split('|@|');
      const titleBase = parts.length >= 2 ? parts[1] : compositeKey;
      indexedFiles.push(titleBase);

      // Split the content into chunks.
      const chunks = chunkText(content, 1000, 100);
      totalChunks += chunks.length;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const title = `${titleBase} - Chunk ${i + 1}`;
        const embedding = await generateEmbedding(chunk);
        allDocuments.push({ title, content: chunk, embedding, file: titleBase });
      }

      processedFiles++;
      // File processing is 0-50% of the total progress
      setIndexProgress(Math.floor((processedFiles / selectedFiles.size) * 50));
    }

    // Insert documents in batches
    await processBatch(allDocuments);

    setIndex(db);

    // Update index stats
    setIndexStats({
      totalFiles: indexedFiles.length,
      totalChunks: totalChunks,
      indexedFiles: indexedFiles,
      lastUpdated: new Date(),
    });

    // Update refs for comparison
    prevSelectedFilesRef.current = new Set(selectedFiles);
    prevFileContentsRef.current = { ...fileContents };

    setIsIndexing(false);
  }, [selectedFiles, fileContents]);

  // Auto-rebuild index when selected files change
  useEffect(() => {
    if (needsReindex && !isIndexing && selectedFiles.size > 0) {
      buildIndex();
    }
  }, [needsReindex, buildIndex, selectedFiles, isIndexing]);

  // Perform a full-text search (hybrid) on the index using the provided query.
  const performSearch = useCallback(async () => {
    if (!index || !query.trim()) return;

    setIsSearching(true);
    const queryEmbedding = await generateEmbedding(query);
    const searchResults = await search(index, {
      mode: 'hybrid',
      term: query,
      vector: {
        value: queryEmbedding,
        property: 'embedding',
      },
      hybridWeights: {
        text: 0.8,
        vector: 0.2,
      },
      limit: 10,
      groupBy: {
        properties: ['file'],
        maxResult: 1,
      },
    });

    // Map results into our SearchResult interface.
    const mappedResults: SearchResult[] = searchResults.hits.map((hit) => ({
      document: {
        title: hit.document.title,
        content: hit.document.content,
        file: hit.document.file,
      },
      score: hit.score,
    }));
    setResults(mappedResults);
    setIsSearching(false);
  }, [index, query]);

  // Format the last updated time
  const formattedLastUpdated = useMemo(() => {
    if (!indexStats.lastUpdated) return 'Never';
    return indexStats.lastUpdated.toLocaleTimeString();
  }, [indexStats.lastUpdated]);

  // Determine the current indexing phase
  const indexingPhase = useMemo(() => {
    if (!isIndexing) return '';
    return indexProgress <= 50 ? 'Processing files' : 'Building index';
  }, [isIndexing, indexProgress]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="space-y-4 p-2 shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Orama Search Panel</h2>
          <div className="flex items-center gap-2">
            {index && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="flex items-center gap-1">
                      <InfoIcon className="h-3 w-3" />
                      {indexStats.totalFiles} files, {indexStats.totalChunks} chunks
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Last updated: {formattedLastUpdated}</p>
                    <p>
                      Indexed files:{' '}
                      {indexStats.indexedFiles.length > 0
                        ? indexStats.indexedFiles.slice(0, 5).join(', ') +
                          (indexStats.indexedFiles.length > 5 ? '...' : '')
                        : 'None'}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>

        {/* Index status and controls */}
        <div className="space-y-2">
          {isIndexing ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm">
                  {indexingPhase}... {indexProgress}%
                </span>
                <span className="text-xs text-muted-foreground">
                  {indexProgress <= 50
                    ? `${Math.floor((indexProgress / 50) * selectedFiles.size)}/${selectedFiles.size} files`
                    : 'Inserting documents in batches'}
                </span>
              </div>
              <Progress value={indexProgress} className="h-2" />
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Button
                  onClick={buildIndex}
                  disabled={isIndexing || selectedFiles.size === 0}
                  size="sm"
                  className="flex items-center gap-1"
                >
                  <RefreshCw className="h-4 w-4" />
                  Rebuild Index
                </Button>
                {index ? (
                  <span className="text-sm text-green-600">
                    Index ready ({indexStats.totalFiles} files)
                  </span>
                ) : selectedFiles.size > 0 ? (
                  <span className="text-sm text-amber-600">Index needs to be built</span>
                ) : (
                  <span className="text-sm text-muted-foreground">Select files to index</span>
                )}
              </div>
              {indexStats.lastUpdated && (
                <span className="text-xs text-muted-foreground">
                  Updated: {formattedLastUpdated}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Query input */}
        <div className="flex items-center gap-2">
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter search query..."
            className="w-full"
            disabled={!index || isIndexing}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim() && !isSearching) {
                performSearch();
              }
            }}
          />
          <Button
            onClick={performSearch}
            disabled={!index || !query.trim() || isSearching || isIndexing}
          >
            {isSearching ? 'Searching...' : 'Search'}
          </Button>
        </div>
      </div>

      {/* Search results - now in a flex-1 container with ScrollArea */}
      <div className="flex-1 overflow-hidden">
        <div className="px-2 pb-2">
          <h3 className="text-base font-medium mb-2">Search Results</h3>
        </div>
        <ScrollArea className="h-full">
          {results.length === 0 ? (
            <div className="text-sm text-muted-foreground border rounded-md p-4 m-2 text-center">
              {isSearching ? (
                <p>Searching...</p>
              ) : !index ? (
                <p>Build an index to search files</p>
              ) : (
                <p>No results found. Try a different search query.</p>
              )}
            </div>
          ) : (
            <div className="p-2">
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-1/4">File</TableHead>
                      <TableHead className="w-1/2">Snippet</TableHead>
                      <TableHead className="w-1/6">Score</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((res, idx) => (
                      <TableRow key={res.document.title || idx}>
                        <TableCell className="font-semibold">{res.document.file}</TableCell>
                        <TableCell>
                          {res.document.content.slice(0, 100)}
                          {res.document.content.length > 100 ? '...' : ''}
                        </TableCell>
                        <TableCell>{res.score.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
};

export default OramaSearchPanel;
