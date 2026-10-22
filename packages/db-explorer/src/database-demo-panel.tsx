import { NativeLibraryPanel } from './components/native-library-panel';
import { getSourceFilesCapability } from './file-import/native-source-import';

interface DatabaseDemoPanelProps {
  onDatabaseCleared: (() => void) | null;
}

export function DatabaseDemoPanel({ onDatabaseCleared }: DatabaseDemoPanelProps) {
  const files = getSourceFilesCapability();
  if (!files) {
    throw new Error('The source files capability is unavailable.');
  }
  return <NativeLibraryPanel files={files} onDatabaseCleared={onDatabaseCleared} />;
}
