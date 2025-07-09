import type { FileRecord } from '@brainstrike/db';
import { useFileRecordRepository } from '@brainstrike/db';
import { useFileExplorer, useSelectionManager } from '@brainstrike/file-explorer-ui';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ImportProgress as ImportProgressComponent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@brainstrike/ui';
import { saveAs } from 'file-saver';
import { Database, Download, FileText, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createCSVBlob, generateCSV, generateCSVFilename } from './csv-export-utils';
import { useFileImportService } from './file-import-service';

export function DatabaseDemoPanel() {
  const repository = useFileRecordRepository();
  const { toast } = useToast();
  const [records, setRecords] = useState<FileRecord[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showImportProgress, setShowImportProgress] = useState(false);
  const [dbInfo, setDbInfo] = useState<{
    location: string;
    testResult: string;
    connected: boolean;
  } | null>(null);

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

  // File import service
  const { isImporting, progress, importFiles } = useFileImportService({
    onProgress: () => {
      setShowImportProgress(true);
    },
    onComplete: (results) => {
      const successful = results.filter((r) => r.imported).length;
      const failed = results.filter((r) => r.error).length;

      toast({
        title: 'Import Complete',
        description: `${successful} files imported${failed > 0 ? `, ${failed} failed` : ''}`,
        variant: failed > 0 ? 'destructive' : 'default',
      });

      // Refresh the records to show new imports
      void loadRecords();
    },
    onError: (error) => {
      toast({
        title: 'Import Failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const loadRecords = useCallback(async () => {
    if (!repository) return;

    try {
      setRefreshing(true);
      // Load only records with content (imported files)
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

  // Test database connection
  const testDatabaseConnection = useCallback(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: Electron API type varies by environment
    if (typeof window !== 'undefined' && (window as any).electronAPI?.db?.test) {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Electron API type varies by environment
        const result = await (window as any).electronAPI.db.test();
        setDbInfo({
          location: result.dbLocation,
          testResult: result.message,
          connected: result.success,
        });
      } catch (error) {
        setDbInfo({
          location: 'Unknown',
          testResult: `Connection test failed: ${error}`,
          connected: false,
        });
      }
    } else {
      setDbInfo({
        location: 'IndexedDB (Web)',
        testResult: 'Using browser IndexedDB storage',
        connected: true,
      });
    }
  }, []);

  // Load records on mount and when repository becomes available
  useEffect(() => {
    if (repository) {
      void loadRecords();
      void testDatabaseConnection();
    }
  }, [repository, loadRecords, testDatabaseConnection]);

  const removeRecord = useCallback(
    async (id: string, name: string) => {
      if (!repository) return;

      try {
        await repository.delete(id);
        await loadRecords();

        toast({
          title: 'Success',
          description: `Removed record: ${name}`,
        });
      } catch (_error) {
        toast({
          title: 'Error',
          description: 'Failed to remove record',
          variant: 'destructive',
        });
      }
    },
    [repository, loadRecords, toast]
  );

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

  // Handle import button click with actual integration
  const handleImportClick = useCallback(() => {
    if (selectedFilePaths.size === 0) {
      toast({
        title: 'No Files Selected',
        description: 'Please select files in the explorer before importing.',
        variant: 'destructive',
      });
      return;
    }

    // Trigger the import with required parameters
    importFiles(selectedFilePaths, fileTree, fileContents);
  }, [selectedFilePaths, fileTree, fileContents, importFiles, toast]);

  // Handle CSV export
  const handleExportCSV = useCallback(() => {
    if (records.length === 0) {
      toast({
        title: 'No Data to Export',
        description: 'Import some files first before exporting to CSV.',
        variant: 'destructive',
      });
      return;
    }

    try {
      const csvContent = generateCSV(records);
      const blob = createCSVBlob(csvContent);
      const filename = generateCSVFilename('database-records');

      saveAs(blob, filename);

      toast({
        title: 'Export Successful',
        description: `Exported ${records.length} records to ${filename}`,
      });
    } catch (error) {
      toast({
        title: 'Export Failed',
        description: error instanceof Error ? error.message : 'Failed to export CSV',
        variant: 'destructive',
      });
    }
  }, [records, toast]);

  if (!repository) {
    return (
      <Card className="h-full">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Database className="h-4 w-4" />
            Database Demo
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
          Database Demo
        </div>
        <div className="text-xs text-muted-foreground mb-3">
          PGlite WASM database with file records table
        </div>
        {dbInfo && (
          <div className="mt-2 p-2 bg-muted rounded text-xs">
            <div className="font-medium">Storage: {dbInfo.location}</div>
            <div className={`mt-1 ${dbInfo.connected ? 'text-green-600' : 'text-red-600'}`}>
              {dbInfo.connected ? '✓' : '✗'} {dbInfo.testResult}
            </div>
          </div>
        )}
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
            onClick={loadRecords}
            disabled={refreshing}
            className="flex items-center gap-1"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportCSV}
            disabled={records.length === 0}
            className="flex items-center gap-1"
          >
            <Download className="h-3 w-3" />
            Export CSV ({records.length})
          </Button>
        </div>

        {showImportProgress && progress && (
          <div className="mt-4">
            <ImportProgressComponent
              progress={progress}
              onClose={() => setShowImportProgress(false)}
            />
          </div>
        )}
      </div>

      <div className="flex-1" style={{ maxHeight: '400px', overflow: 'auto' }}>
        {records.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-4">
            No imported files found. Select files in the explorer and click "Import Selected Files"
            to add them to the database.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Path</TableHead>
                <TableHead className="w-20">Size</TableHead>
                <TableHead className="w-16">Tokens</TableHead>
                <TableHead className="w-32">Imported</TableHead>
                <TableHead className="w-12">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((record, index) => (
                <TableRow key={record.id}>
                  <TableCell className="text-xs text-muted-foreground">{index + 1}</TableCell>
                  <TableCell className="font-mono text-xs">{record.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {record.path}
                  </TableCell>
                  <TableCell className="text-xs">{formatFileSize(record.size)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {record.tokenCount || '-'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {record.processedAt
                      ? formatDate(record.processedAt)
                      : formatDate(record.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeRecord(record.id, record.name)}
                      className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                      title="Remove record"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
