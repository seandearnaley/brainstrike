import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@brainstrike/ui';
import { Button } from '@brainstrike/ui';
import { ScrollArea } from '@brainstrike/ui';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@brainstrike/ui';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@brainstrike/ui';
import { GitBranch, GitCompare, Loader2 } from 'lucide-react';
import * as React from 'react';
import { memo, useMemo, useRef } from 'react';
import { cn } from '../../lib/utils';
import { useGitStore } from '../../stores/git-store';
import { AnalysisPanel } from './analysis-panel';

interface GitPanelProps {
  rootDirectoryHandle: FileSystemDirectoryHandle | null;
}

const LoadingButton: React.FC<{
  isLoading: boolean;
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  loadingText: string;
  text: string;
  className?: string;
}> = ({ isLoading, onClick, disabled, icon, loadingText, text, className }) => (
  <Button
    variant="secondary"
    onClick={onClick}
    disabled={disabled || isLoading}
    size="sm"
    className={cn('h-9', className)}
  >
    {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : icon}
    {isLoading ? loadingText : text}
  </Button>
);

const BranchSelector: React.FC<{
  value: string;
  onChange: (value: string) => void;
  branches: string[];
  placeholder: string;
}> = ({ value, onChange, branches, placeholder }) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger className="h-9">
      <SelectValue placeholder={placeholder} />
    </SelectTrigger>
    <SelectContent>
      {branches.map((branch) => (
        <SelectItem key={branch} value={branch}>
          {branch}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const CommitAccordion: React.FC<{
  commits: Array<{
    oid: string;
    commit: {
      message: string;
      author: { name: string; email: string; timestamp: number };
    };
  }>;
}> = ({ commits }) => (
  <Accordion type="single" collapsible className="w-full">
    {commits.map((commit) => (
      <AccordionItem key={commit.oid} value={commit.oid}>
        <AccordionTrigger className="hover:no-underline">
          <div className="flex flex-col items-start text-left">
            <div className="font-medium">{commit.commit.message.split('\n')[0]}</div>
            <div className="text-xs text-muted-foreground">
              {commit.commit.author.name} &lt;{commit.commit.author.email}&gt; •{' '}
              {new Date(commit.commit.author.timestamp * 1000).toLocaleString()}
            </div>
          </div>
        </AccordionTrigger>
        <AccordionContent>
          <div className="text-sm">
            <div className="font-mono text-xs mb-2">Commit: {commit.oid}</div>
            <pre className="whitespace-pre-wrap">{commit.commit.message}</pre>
          </div>
        </AccordionContent>
      </AccordionItem>
    ))}
  </Accordion>
);

const DiffLine: React.FC<{
  line: string;
  prefix: string;
  lineNumber: number;
  type: 'add' | 'remove';
}> = memo(({ line, prefix, lineNumber, type }) => (
  <div
    key={lineNumber}
    className={`hover:bg-${type === 'add' ? 'green' : 'red'}-50 ${
      type === 'add' ? 'text-green-600' : 'text-red-600'
    }`}
  >
    {prefix} {line}
  </div>
));
DiffLine.displayName = 'DiffLine';

const DiffContent: React.FC<{
  content: string | undefined;
  type: 'add' | 'remove';
  filePath: string;
}> = memo(({ content, type, filePath }) => {
  if (!content) return null;

  const lines = useMemo(() => {
    const allLines = content.split('\n');
    // For new files, show first few lines
    if (allLines.length > 7) {
      return allLines.slice(0, 7).concat(['...']);
    }
    return allLines;
  }, [content]);

  return (
    <div>
      {lines.map((line, idx) => {
        const key =
          line === '...' ? `${filePath}-${type}-ellipsis` : `${filePath}-${type}-line-${idx}`;
        return (
          <div key={key} className="flex">
            <span className="w-8 text-gray-500 select-none font-mono">
              {line === '...' ? '' : idx + 1}
            </span>
            <span className={type === 'add' ? 'text-green-600' : 'text-red-600'}>
              {line === '...' ? line : `${type === 'add' ? '+' : '-'} ${line}`}
            </span>
          </div>
        );
      })}
    </div>
  );
});
DiffContent.displayName = 'DiffContent';

const MAX_LINES = 200;
const PREVIEW_LINES = 20;

// Function to detect if content is likely a binary file
const isBinaryContent = (content: string | undefined): boolean => {
  if (!content) return false;

  // Check for null bytes which are common in binary files
  if (content.includes('\0')) return true;

  // Check for high concentration of non-printable characters
  // Count characters outside the printable ASCII range
  let nonPrintableCount = 0;
  const sampleSize = Math.min(content.length, 1000); // Check first 1000 chars

  for (let i = 0; i < sampleSize; i++) {
    const charCode = content.charCodeAt(i);
    if ((charCode < 32 && charCode !== 9 && charCode !== 10 && charCode !== 13) || charCode > 126) {
      nonPrintableCount++;
    }
  }

  // If more than 10% are non-printable, consider it binary
  return nonPrintableCount > sampleSize * 0.1;
};

const DiffFile: React.FC<{
  diff: {
    path: string;
    type: 'add' | 'modify' | 'remove';
    oldContent: string | undefined;
    newContent: string | undefined;
  };
}> = memo(({ diff }) => {
  const [isExpanded, setIsExpanded] = React.useState(false);

  const renderFileHeader = () => {
    if (diff.type === 'add') return 'new file mode 100644';
    if (diff.type === 'remove') return 'deleted file mode 100644';
    return 'modified';
  };

  const renderDiffHeader = () => {
    if (diff.type === 'add') return `--- /dev/null\n+++ b/${diff.path}`;
    if (diff.type === 'remove') return `--- a/${diff.path}\n+++ /dev/null`;
    return `--- a/${diff.path}\n+++ b/${diff.path}`;
  };

  const processContent = (content: string | undefined) => {
    if (!content) return [];
    const lines = content.split('\n');

    // For small files, show everything
    if (lines.length <= PREVIEW_LINES) return lines;

    // For large files in preview mode
    if (!isExpanded) {
      return lines.slice(0, PREVIEW_LINES).concat(['...']);
    }

    // For expanded large files, limit to MAX_LINES
    if (lines.length > MAX_LINES) {
      return lines.slice(0, MAX_LINES).concat(['...']);
    }

    return lines;
  };

  const renderLines = (lines: string[], type: 'add' | 'remove') => {
    return lines.map((line, idx) => (
      <div
        key={`${diff.path}-${type}-${idx}`}
        className={`hover:bg-${type === 'add' ? 'green' : 'red'}-50`}
      >
        <span className="w-8 inline-block text-gray-500 select-none">
          {line === '...' ? '' : idx + 1}
        </span>
        <span className={type === 'add' ? 'text-green-600' : 'text-red-600'}>
          {line === '...' ? line : `${type === 'add' ? '+' : '-'} ${line}`}
        </span>
      </div>
    ));
  };

  const contentLines =
    diff.type === 'add'
      ? processContent(diff.newContent)
      : diff.type === 'remove'
        ? processContent(diff.oldContent)
        : [];

  const showExpandButton =
    (diff.newContent?.split('\n').length ?? 0) > PREVIEW_LINES ||
    (diff.oldContent?.split('\n').length ?? 0) > PREVIEW_LINES;

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between p-2 bg-muted border-b">
        <div className="flex items-center gap-2">
          <span className="font-medium font-mono">{diff.path}</span>
          <span className="text-xs text-muted-foreground">{renderFileHeader()}</span>
        </div>
        <span
          className={`px-2 py-1 rounded-full text-xs ${
            diff.type === 'add'
              ? 'bg-green-100 text-green-800'
              : diff.type === 'remove'
                ? 'bg-red-100 text-red-800'
                : 'bg-yellow-100 text-yellow-800'
          }`}
        >
          {diff.type}
        </span>
      </div>
      <div className="text-xs font-mono bg-muted/50 p-2">
        <div className="text-gray-500 mb-1">{renderDiffHeader()}</div>
        <div>
          {diff.type === 'add' && renderLines(contentLines, 'add')}
          {diff.type === 'remove' && renderLines(contentLines, 'remove')}
          {diff.type === 'modify' && (
            <>
              {renderLines(processContent(diff.oldContent), 'remove')}
              {renderLines(processContent(diff.newContent), 'add')}
            </>
          )}
        </div>
        {showExpandButton && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            className="mt-2 w-full"
          >
            {isExpanded ? 'Show Less' : 'Show More'}
          </Button>
        )}
      </div>
    </div>
  );
});
DiffFile.displayName = 'DiffFile';

const DiffViewer: React.FC<{
  diffs: Array<{
    path: string;
    type: 'add' | 'modify' | 'remove';
    oldContent: string | undefined;
    newContent: string | undefined;
  }>;
}> = memo(({ diffs }) => {
  // Filter out binary files
  const textDiffs = diffs.filter((diff) => {
    // Check file extensions commonly associated with binary files
    const binaryExtensions = [
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.bmp',
      '.ico',
      '.pdf',
      '.zip',
      '.tar',
      '.gz',
      '.exe',
      '.dll',
      '.so',
      '.dylib',
      '.class',
      '.jar',
      '.war',
      '.ear',
    ];

    const hasBinaryExtension = binaryExtensions.some((ext) =>
      diff.path.toLowerCase().endsWith(ext)
    );

    // Check content for binary data
    const oldContentIsBinary = isBinaryContent(diff.oldContent);
    const newContentIsBinary = isBinaryContent(diff.newContent);

    return !hasBinaryExtension && !oldContentIsBinary && !newContentIsBinary;
  });

  // If there are binary files that were filtered out, show a message
  const binaryFilesCount = diffs.length - textDiffs.length;

  return (
    <div className="space-y-4">
      {binaryFilesCount > 0 && (
        <div className="text-sm text-muted-foreground p-2 border rounded bg-muted/50">
          {binaryFilesCount} binary file{binaryFilesCount !== 1 ? 's' : ''} not shown
        </div>
      )}
      {textDiffs.map((diff) => (
        <DiffFile key={diff.path} diff={diff} />
      ))}
    </div>
  );
});
DiffViewer.displayName = 'DiffViewer';

const ErrorMessage: React.FC<{
  message: string;
  onRetry?: (() => Promise<void>) | undefined;
}> = ({ message, onRetry }) => (
  <div className="flex items-center justify-between text-sm text-red-500 mb-4 p-2 border border-red-200 rounded">
    <span>{message}</span>
    {onRetry && (
      <Button variant="outline" size="sm" onClick={() => onRetry()}>
        Retry
      </Button>
    )}
  </div>
);

const HistoryTab: React.FC<{
  commits: Array<{
    oid: string;
    commit: {
      message: string;
      author: { name: string; email: string; timestamp: number };
    };
  }>;
  status: string;
  error: { message: string; retry?: () => Promise<void> } | null;
  onLoadHistory: () => void;
}> = memo(({ commits, status, error, onLoadHistory }) => {
  const isLoading = status === 'loading_history';
  const hasCommits = commits.length > 0;

  return (
    <div className="space-y-4">
      {!hasCommits && !isLoading && (
        <LoadingButton
          onClick={onLoadHistory}
          isLoading={false}
          icon={<GitBranch className="mr-2 h-4 w-4" />}
          loadingText="Loading History..."
          text="View Commit History"
          className="w-full"
        />
      )}

      {error && <ErrorMessage message={error.message} onRetry={error.retry} />}

      <div className={isLoading && !hasCommits ? 'opacity-50 pointer-events-none' : ''}>
        {hasCommits && <CommitAccordion commits={commits} />}
        {isLoading && !hasCommits && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
          </div>
        )}
      </div>
    </div>
  );
});
HistoryTab.displayName = 'HistoryTab';

export const GitPanel: React.FC<GitPanelProps> = ({ rootDirectoryHandle }) => {
  const {
    status,
    isGitRepo,
    commits,
    branches,
    selectedBaseBranch,
    selectedCompareBranch,
    diffResultsByPair,
    error,
    activeTab,
    initializeFS,
    loadCommitHistory,
    compareBranches,
    setSelectedBranches,
    setActiveTab,
  } = useGitStore();

  const initializingHandleRef = useRef<FileSystemDirectoryHandle | null>(null);

  React.useEffect(() => {
    if (rootDirectoryHandle && rootDirectoryHandle !== initializingHandleRef.current) {
      initializingHandleRef.current = rootDirectoryHandle;
      initializeFS(rootDirectoryHandle).catch((error) => {
        console.error('[GitPanel] Error during initializeFS call:', error);
      });
    }

    return () => {
      console.log('[GitPanel] useEffect cleanup.');
      // No longer clearing state here to avoid race conditions with Strict Mode.
      // The state will clear when the rootDirectoryHandle *actually* changes or the component unmounts.
    };
  }, [rootDirectoryHandle, initializeFS]);

  if (status === 'initializing' || status === 'loading_branches') {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!isGitRepo) {
    return <div className="text-sm text-muted-foreground p-4">No Git repository detected</div>;
  }

  const diffKey = `${selectedBaseBranch}...${selectedCompareBranch}`;
  const currentDiffs = diffResultsByPair[diffKey] || [];

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <Tabs
        defaultValue="history"
        value={activeTab}
        onValueChange={(value) =>
          setActiveTab(value as 'history' | 'compare' | 'recent' | 'hotspots')
        }
        className="h-full flex flex-col"
      >
        <TabsList className="grid w-full grid-cols-3 shrink-0">
          <TabsTrigger value="history">
            <GitBranch className="mr-2 h-4 w-4" />
            History
          </TabsTrigger>
          <TabsTrigger value="compare">
            <GitCompare className="mr-2 h-4 w-4" />
            Compare
          </TabsTrigger>
          <TabsTrigger value="analysis">Analysis</TabsTrigger>
        </TabsList>

        <TabsContent value="history" className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-4">
              <HistoryTab
                commits={commits}
                status={status}
                error={error}
                onLoadHistory={loadCommitHistory}
              />
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="compare" className="flex-1 overflow-hidden">
          <div className="flex flex-col h-full">
            <div className="p-4 space-y-4 shrink-0">
              <div className="grid grid-cols-2 gap-4">
                <BranchSelector
                  value={selectedBaseBranch}
                  onChange={(value) => setSelectedBranches(value, selectedCompareBranch)}
                  branches={branches}
                  placeholder="Select base branch"
                />
                <BranchSelector
                  value={selectedCompareBranch}
                  onChange={(value) => setSelectedBranches(selectedBaseBranch, value)}
                  branches={branches}
                  placeholder="Select compare branch"
                />
              </div>

              <LoadingButton
                onClick={compareBranches}
                isLoading={status === 'comparing'}
                disabled={!selectedBaseBranch || !selectedCompareBranch}
                icon={<GitCompare className="mr-2 h-4 w-4" />}
                loadingText="Comparing..."
                text="Compare Branches"
                className="w-full"
              />

              {error && <ErrorMessage message={error.message} onRetry={error.retry} />}
            </div>

            {currentDiffs.length > 0 && (
              <div className="flex-1 overflow-hidden">
                <ScrollArea className="h-full">
                  <div className="p-4">
                    <DiffViewer diffs={currentDiffs} />
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="analysis" className="flex-1 overflow-hidden">
          <AnalysisPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
};
