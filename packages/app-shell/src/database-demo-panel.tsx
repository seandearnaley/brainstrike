import { useFileRecordRepository } from '@brainstrike/db';
import type { FileRecord } from '@brainstrike/db';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@brainstrike/ui';
import { Database, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

export function DatabaseDemoPanel() {
  const repository = useFileRecordRepository();
  const { toast } = useToast();
  const [records, setRecords] = useState<FileRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadRecords = useCallback(async () => {
    if (!repository) return;

    try {
      setRefreshing(true);
      const allRecords = await repository.findAll();
      setRecords(allRecords);
    } catch (error) {
      console.error('Failed to load records:', error);
      toast({
        title: 'Error',
        description: 'Failed to load database records',
        variant: 'destructive',
      });
    } finally {
      setRefreshing(false);
    }
  }, [repository, toast]);

  // Load records on mount and when repository becomes available
  useEffect(() => {
    if (repository) {
      loadRecords();
    }
  }, [repository, loadRecords]);

  const addTestRecord = useCallback(async () => {
    if (!repository) return;

    try {
      setLoading(true);
      const now = new Date().toISOString();
      const randomId = Math.random().toString(36).substring(2, 15);
      const testRecord: FileRecord = {
        id: `demo-${randomId}`,
        name: `test-file-${randomId}.txt`,
        path: `/demo/test-file-${randomId}.txt`,
        size: Math.floor(Math.random() * 10000) + 100,
        createdAt: now,
        updatedAt: now,
      };

      await repository.create(testRecord);
      await loadRecords();

      toast({
        title: 'Success',
        description: `Added test record: ${testRecord.name}`,
      });
    } catch (error) {
      console.error('Failed to add test record:', error);
      toast({
        title: 'Error',
        description: 'Failed to add test record',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [repository, loadRecords, toast]);

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
      } catch (error) {
        console.error('Failed to remove record:', error);
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
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3 flex-shrink-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <Database className="h-4 w-4" />
          Database Demo
        </CardTitle>
        <CardDescription className="text-xs">
          PGlite WASM database with file records table
        </CardDescription>
        <div className="flex gap-2 pt-2">
          <Button
            size="sm"
            onClick={addTestRecord}
            disabled={loading}
            className="flex items-center gap-1"
          >
            <Plus className="h-3 w-3" />
            Add Test Record
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
        </div>
      </CardHeader>

      <CardContent className="flex-1 overflow-hidden p-0">
        {records.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            No records found. Click "Add Test Record" to create some data.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Path</TableHead>
                <TableHead className="w-20">Size</TableHead>
                <TableHead className="w-32">Created</TableHead>
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
                    {formatDate(record.createdAt)}
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
      </CardContent>
    </Card>
  );
}
