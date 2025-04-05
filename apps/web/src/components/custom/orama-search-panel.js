import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { create, insertMultiple, search } from '@orama/orama';
import { InfoIcon, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Progress } from '../../components/ui/progress';
import { ScrollArea } from '../../components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, } from '../../components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, } from '../../components/ui/tooltip';
// Define the Orama schema: each document has a title, content, embedding (384-d vector), and file ID
const schema = {
    title: 'string',
    content: 'string',
    embedding: 'vector[384]',
    file: 'string',
};
// Dummy embedding generator function; in production, replace with a real model.
async function generateEmbedding(_text) {
    return new Array(384).fill(0).map(() => Math.random());
}
// Chunk text into overlapping segments to preserve context.
function chunkText(text, maxChunkSize = 1000, overlap = 100) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + maxChunkSize, text.length);
        chunks.push(text.slice(start, end));
        if (end === text.length)
            break;
        start = end - overlap;
        if (start < 0)
            start = 0;
        if (start >= text.length)
            break;
    }
    return chunks;
}
export const OramaSearchPanel = ({ selectedFiles, fileContents, }) => {
    const [index, setIndex] = useState(null);
    const [isIndexing, setIsIndexing] = useState(false);
    const [indexProgress, setIndexProgress] = useState(0);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [indexStats, setIndexStats] = useState({
        totalFiles: 0,
        totalChunks: 0,
        indexedFiles: [],
        lastUpdated: null,
    });
    const [isSearching, setIsSearching] = useState(false);
    // Store previous selected files for comparison
    const prevSelectedFilesRef = useRef(new Set());
    const prevFileContentsRef = useRef({});
    // Check if the index needs to be rebuilt
    const needsReindex = useMemo(() => {
        // If no index exists, we need to build one
        if (!index)
            return true;
        // If the number of selected files has changed
        if (prevSelectedFilesRef.current.size !== selectedFiles.size)
            return true;
        // If the selected files have changed
        for (const file of selectedFiles) {
            if (!prevSelectedFilesRef.current.has(file))
                return true;
            // If the content of any file has changed
            if (prevFileContentsRef.current[file] !== fileContents[file])
                return true;
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
        const indexedFiles = [];
        let totalChunks = 0;
        let processedFiles = 0;
        // Helper function to process in batches with a small delay to avoid blocking the main thread
        const processBatch = async (documents, batchSize = 100) => {
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
        const allDocuments = [];
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
        if (!index || !query.trim())
            return;
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
        const mappedResults = searchResults.hits.map((hit) => ({
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
        if (!indexStats.lastUpdated)
            return 'Never';
        return indexStats.lastUpdated.toLocaleTimeString();
    }, [indexStats.lastUpdated]);
    // Determine the current indexing phase
    const indexingPhase = useMemo(() => {
        if (!isIndexing)
            return '';
        return indexProgress <= 50 ? 'Processing files' : 'Building index';
    }, [isIndexing, indexProgress]);
    return (_jsxs("div", { className: "flex flex-col h-full overflow-hidden", children: [_jsxs("div", { className: "space-y-4 p-2 shrink-0", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h2", { className: "text-lg font-semibold", children: "Orama Search Panel" }), _jsx("div", { className: "flex items-center gap-2", children: index && (_jsx(TooltipProvider, { children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsxs(Badge, { variant: "outline", className: "flex items-center gap-1", children: [_jsx(InfoIcon, { className: "h-3 w-3" }), indexStats.totalFiles, " files, ", indexStats.totalChunks, " chunks"] }) }), _jsxs(TooltipContent, { children: [_jsxs("p", { children: ["Last updated: ", formattedLastUpdated] }), _jsxs("p", { children: ["Indexed files:", ' ', indexStats.indexedFiles.length > 0
                                                                ? indexStats.indexedFiles.slice(0, 5).join(', ') +
                                                                    (indexStats.indexedFiles.length > 5 ? '...' : '')
                                                                : 'None'] })] })] }) })) })] }), _jsx("div", { className: "space-y-2", children: isIndexing ? (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("span", { className: "text-sm", children: [indexingPhase, "... ", indexProgress, "%"] }), _jsx("span", { className: "text-xs text-muted-foreground", children: indexProgress <= 50
                                                ? `${Math.floor((indexProgress / 50) * selectedFiles.size)}/${selectedFiles.size} files`
                                                : 'Inserting documents in batches' })] }), _jsx(Progress, { value: indexProgress, className: "h-2" })] })) : (_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsxs(Button, { onClick: buildIndex, disabled: isIndexing || selectedFiles.size === 0, size: "sm", className: "flex items-center gap-1", children: [_jsx(RefreshCw, { className: "h-4 w-4" }), "Rebuild Index"] }), index ? (_jsxs("span", { className: "text-sm text-green-600", children: ["Index ready (", indexStats.totalFiles, " files)"] })) : selectedFiles.size > 0 ? (_jsx("span", { className: "text-sm text-amber-600", children: "Index needs to be built" })) : (_jsx("span", { className: "text-sm text-muted-foreground", children: "Select files to index" }))] }), indexStats.lastUpdated && (_jsxs("span", { className: "text-xs text-muted-foreground", children: ["Updated: ", formattedLastUpdated] }))] })) }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Input, { type: "text", value: query, onChange: (e) => setQuery(e.target.value), placeholder: "Enter search query...", className: "w-full", disabled: !index || isIndexing, onKeyDown: (e) => {
                                    if (e.key === 'Enter' && query.trim() && !isSearching) {
                                        performSearch();
                                    }
                                } }), _jsx(Button, { onClick: performSearch, disabled: !index || !query.trim() || isSearching || isIndexing, children: isSearching ? 'Searching...' : 'Search' })] })] }), _jsxs("div", { className: "flex-1 overflow-hidden", children: [_jsx("div", { className: "px-2 pb-2", children: _jsx("h3", { className: "text-base font-medium mb-2", children: "Search Results" }) }), _jsx(ScrollArea, { className: "h-full", children: results.length === 0 ? (_jsx("div", { className: "text-sm text-muted-foreground border rounded-md p-4 m-2 text-center", children: isSearching ? (_jsx("p", { children: "Searching..." })) : !index ? (_jsx("p", { children: "Build an index to search files" })) : (_jsx("p", { children: "No results found. Try a different search query." })) })) : (_jsx("div", { className: "p-2", children: _jsx("div", { className: "rounded-md border", children: _jsxs(Table, { children: [_jsx(TableHeader, { children: _jsxs(TableRow, { children: [_jsx(TableHead, { className: "w-1/4", children: "File" }), _jsx(TableHead, { className: "w-1/2", children: "Snippet" }), _jsx(TableHead, { className: "w-1/6", children: "Score" })] }) }), _jsx(TableBody, { children: results.map((res, idx) => (_jsxs(TableRow, { children: [_jsx(TableCell, { className: "font-semibold", children: res.document.file }), _jsxs(TableCell, { children: [res.document.content.slice(0, 100), res.document.content.length > 100 ? '...' : ''] }), _jsx(TableCell, { children: res.score.toFixed(2) })] }, res.document.title || idx))) })] }) }) })) })] })] }));
};
export default OramaSearchPanel;
