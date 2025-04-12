import type {} from 'lucide-react';
import * as React from 'react';

// Extend LucideProps to include data-testid
interface ExtendedLucideProps {
  size?: number | string;
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
  // biome-ignore lint/suspicious/noExplicitAny: This is a mock implementation for tests
  [key: string]: any;
}

// Mock implementation of lucide-react icons
const createMockIcon = (
  name: string,
  render?: (props: ExtendedLucideProps) => React.ReactElement
) => {
  const Icon = (props: ExtendedLucideProps) => {
    if (render) {
      return render(props);
    }
    const { size = 24, className, 'aria-label': ariaLabel, 'data-testid': testId, ...rest } = props;
    return React.createElement('svg', {
      width: size,
      height: size,
      className,
      'aria-label': ariaLabel,
      'data-testid': testId,
      ...rest,
    });
  };
  Icon.displayName = name;
  return Icon;
};

// Export all icons used in tests
export const AlertCircle = createMockIcon('AlertCircle');
export const ArrowUpDown = createMockIcon('ArrowUpDown');
export const Check = createMockIcon('Check');
export const ChevronDown = createMockIcon('ChevronDown');
export const ChevronRight = createMockIcon('ChevronRight');
export const ChevronsDown = createMockIcon('ChevronsDown');
export const ChevronsUp = createMockIcon('ChevronsUp');
export const File = createMockIcon('File');
export const FileIcon = createMockIcon('FileIcon');
export const FileText = createMockIcon('FileText');
export const Folder = createMockIcon('Folder');
export const FolderOpen = createMockIcon('FolderOpen');
export const GitBranch = createMockIcon('GitBranch');
export const GitCompare = createMockIcon('GitCompare');
export const Info = createMockIcon('Info');
export const Loader2 = createMockIcon(
  'Loader2',
  (props: ExtendedLucideProps): React.ReactElement => {
    const { size, className, 'aria-label': ariaLabel, ...rest } = props;
    return React.createElement(
      'div',
      {
        'data-testid': 'loading-spinner',
        'aria-label': ariaLabel,
        className,
        ...rest,
      },
      'Loading Icon'
    );
  }
);
export const Minus = createMockIcon('Minus');
export const Monitor = createMockIcon('Monitor');
export const Moon = createMockIcon('Moon');
export const RefreshCw = createMockIcon('RefreshCw');
export const Settings = createMockIcon('Settings');
export const Sun = createMockIcon('Sun');
export const X = createMockIcon('X');

// Export all icons for dynamic imports
export default {
  AlertCircle,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  File,
  FileIcon,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompare,
  Info,
  Loader2,
  Minus,
  Monitor,
  Moon,
  RefreshCw,
  Settings,
  Sun,
  X,
};
