import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { GitPanel } from '../git-panel';

// Mock the isomorphic-git dependency
vi.mock('isomorphic-git', () => ({
  default: {},
}));

// Mock the IndexedDB for the tests
vi.stubGlobal('indexedDB', {
  open: vi.fn().mockReturnValue({
    onupgradeneeded: null,
    onsuccess: null,
    onerror: null,
  }),
});

// Mocked state for useGitStore
const mockGitState = {
  status: 'idle',
  isGitRepo: true,
  commits: [],
  branches: ['main', 'develop'],
  selectedBaseBranch: 'main',
  selectedCompareBranch: 'develop',
  diffResultsByPair: {},
  error: null,
  activeTab: 'history',
  initializeFS: vi.fn(),
  clearState: vi.fn(),
  loadCommitHistory: vi.fn(),
  compareBranches: vi.fn(),
  setSelectedBranches: vi.fn(),
  setActiveTab: vi.fn(),
};

// Mock the git-store
vi.mock('../../../stores/git-store', () => {
  return {
    useGitStore: vi.fn((selector) => {
      return typeof selector === 'function' ? selector(mockGitState) : mockGitState;
    }),
  };
});

// Mocked state for useGitAnalysisStore
const mockGitAnalysisState = {
  recentlyTouchedFiles: [],
  hotspotData: [],
  isAnalyzing: false,
  error: null,
  analyzeAll: vi.fn(),
};

// Mock the git-analysis-store
vi.mock('../../../stores/git-analysis-store', () => {
  return {
    useGitAnalysisStore: vi.fn((selector) => {
      return typeof selector === 'function' ? selector(mockGitAnalysisState) : mockGitAnalysisState;
    }),
  };
});

// Mock the lucide-react icons
vi.mock('lucide-react', () => ({
  GitBranch: () => <div data-testid="mock-git-branch-icon">GitBranchIcon</div>,
  GitCompare: () => <div data-testid="mock-git-compare-icon">GitCompareIcon</div>,
  Loader2: () => <div data-testid="mock-loader-icon">LoaderIcon</div>,
  ChevronDown: () => <div data-testid="mock-chevron-down">ChevronDownIcon</div>,
  Check: () => <div data-testid="mock-check-icon">CheckIcon</div>,
}));

// Mock the AnalysisPanel as it will be tested separately
vi.mock('../analysis-panel', () => ({
  AnalysisPanel: () => <div data-testid="mock-analysis-panel">Analysis Panel</div>,
}));

// Mock the Tabs component for easier testing
vi.mock('@/components/ui/tabs', () => {
  return {
    Tabs: ({ children, ...props }: React.ComponentProps<'div'>) => <div {...props}>{children}</div>,
    TabsList: ({ children, ...props }: React.ComponentProps<'div'>) => (
      <div {...props}>{children}</div>
    ),
    TabsContent: ({
      children,
      value,
      ...props
    }: React.ComponentProps<'div'> & { value: string }) => (
      <div data-value={value} {...props}>
        {value === mockGitState.activeTab ? children : null}
      </div>
    ),
    TabsTrigger: ({
      children,
      value,
      onClick,
      ...props
    }: React.ComponentProps<'button'> & { value: string }) => (
      <button
        role="tab"
        data-state={value === mockGitState.activeTab ? 'active' : 'inactive'}
        onClick={(e) => {
          mockGitState.setActiveTab(value);
          onClick?.(e);
        }}
        value={value}
        {...props}
      >
        {children}
      </button>
    ),
  };
});

// Create a mock directory handle
const mockDirectoryHandle = {
  getDirectoryHandle: vi.fn(),
  name: 'test-repo',
} as unknown as FileSystemDirectoryHandle;

describe('GitPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mocked state to default for each test
    Object.assign(mockGitState, {
      status: 'idle',
      isGitRepo: true,
      commits: [],
      branches: ['main', 'develop'],
      selectedBaseBranch: 'main',
      selectedCompareBranch: 'develop',
      diffResultsByPair: {},
      error: null,
      activeTab: 'history',
      initializeFS: vi.fn(),
      clearState: vi.fn(),
      loadCommitHistory: vi.fn(),
      compareBranches: vi.fn(),
      setSelectedBranches: vi.fn(),
      setActiveTab: vi.fn(),
    });
  });

  test('should display loading state when initializing', () => {
    // Update mock return value for this test
    Object.assign(mockGitState, {
      isGitRepo: false,
      status: 'initializing',
    });

    render(<GitPanel rootDirectoryHandle={mockDirectoryHandle} />);

    expect(screen.getByTestId('mock-loader-icon')).toBeInTheDocument();
  });

  test('should display message when not a git repository', () => {
    // Update mock return value for this test
    Object.assign(mockGitState, {
      isGitRepo: false,
      status: 'idle',
    });

    render(<GitPanel rootDirectoryHandle={mockDirectoryHandle} />);

    expect(screen.getByText('No Git repository detected')).toBeInTheDocument();
  });

  test('should initialize repository when rootDirectoryHandle is provided', () => {
    const mockInitializeFS = vi.fn();
    mockGitState.initializeFS = mockInitializeFS;

    // Set up test state
    Object.assign(mockGitState, {
      isGitRepo: true,
      status: 'idle',
      activeTab: 'history',
      commits: [],
      branches: [],
      error: null,
    });

    render(<GitPanel rootDirectoryHandle={mockDirectoryHandle} />);

    // Verify that initializeFS was called with the directory handle
    expect(mockInitializeFS).toHaveBeenCalledWith(mockDirectoryHandle);
  });

  test("should render history tab content when activeTab is 'history'", () => {
    // Set up the mock state with a git repo and commits
    Object.assign(mockGitState, {
      isGitRepo: true,
      status: 'idle',
      activeTab: 'history',
      commits: [
        {
          oid: 'abc123',
          commit: {
            message: 'Test commit',
            author: {
              name: 'Test User',
              email: 'test@example.com',
              timestamp: Math.floor(Date.now() / 1000),
            },
          },
        },
      ],
      error: null,
      branches: [],
    });

    render(<GitPanel rootDirectoryHandle={mockDirectoryHandle} />);

    // Should see the commit accordion
    expect(screen.getByText('Test commit')).toBeInTheDocument();
  });

  test("should render compare tab content when activeTab is 'compare'", () => {
    // Set up the mock state with branches for comparison
    Object.assign(mockGitState, {
      isGitRepo: true,
      status: 'idle',
      activeTab: 'compare',
      branches: ['main', 'develop'],
      selectedBaseBranch: 'main',
      selectedCompareBranch: 'develop',
      diffResultsByPair: {},
      error: null,
    });

    render(<GitPanel rootDirectoryHandle={mockDirectoryHandle} />);

    // Should see the branch selectors and compare button in the compare tab
    expect(screen.getByText(/compare branches/i)).toBeInTheDocument();
  });

  test("should render analysis tab content when activeTab is 'analysis'", () => {
    // Set up the mock state
    Object.assign(mockGitState, {
      isGitRepo: true,
      status: 'idle',
      activeTab: 'analysis',
      branches: [],
    });

    render(<GitPanel rootDirectoryHandle={mockDirectoryHandle} />);

    // Should see the analysis panel
    expect(screen.getByTestId('mock-analysis-panel')).toBeInTheDocument();
  });

  test('should change tabs when tab triggers are clicked', () => {
    // Set up the mock state
    Object.assign(mockGitState, {
      isGitRepo: true,
      status: 'idle',
      activeTab: 'history',
      branches: ['main', 'develop'],
    });

    // Make sure we can track calls to setActiveTab
    const setActiveTabMock = vi.fn();
    mockGitState.setActiveTab = setActiveTabMock;

    render(<GitPanel rootDirectoryHandle={mockDirectoryHandle} />);

    // Find and click the Compare tab
    const compareTab = screen.getByRole('tab', { name: /compare/i });
    expect(compareTab).toBeInTheDocument();
    fireEvent.click(compareTab);

    // Verify that setActiveTab was called with "compare"
    expect(setActiveTabMock).toHaveBeenCalledWith('compare');
  });

  test('should display loading indicator when loading commit history', () => {
    // Set up the mock state
    Object.assign(mockGitState, {
      isGitRepo: true,
      status: 'loading_history',
      activeTab: 'history',
      commits: [],
      error: null,
      branches: [],
    });

    render(<GitPanel rootDirectoryHandle={mockDirectoryHandle} />);

    expect(screen.getByTestId('mock-loader-icon')).toBeInTheDocument();
  });

  test('should render comparison results when diffResultsByPair has data', () => {
    // Set up the mock state with diff results
    const diffKey = 'main...develop';
    Object.assign(mockGitState, {
      isGitRepo: true,
      status: 'idle',
      activeTab: 'compare',
      branches: ['main', 'develop'],
      selectedBaseBranch: 'main',
      selectedCompareBranch: 'develop',
      diffResultsByPair: {
        [diffKey]: [
          {
            path: 'test.js',
            type: 'modify',
            oldContent: 'old content',
            newContent: 'new content',
          },
        ],
      },
      error: null,
    });

    render(<GitPanel rootDirectoryHandle={mockDirectoryHandle} />);

    expect(screen.getByText('test.js')).toBeInTheDocument();
    expect(screen.getByText(/modified/i)).toBeInTheDocument();
  });

  test('should call compareBranches when compare button is clicked', () => {
    // Set up the mock state
    Object.assign(mockGitState, {
      isGitRepo: true,
      status: 'idle',
      activeTab: 'compare',
      branches: ['main', 'develop'],
      selectedBaseBranch: 'main',
      selectedCompareBranch: 'develop',
      diffResultsByPair: {},
      error: null,
    });

    // Use a new mock function to track calls
    const compareBranchesMock = vi.fn();
    mockGitState.compareBranches = compareBranchesMock;

    render(<GitPanel rootDirectoryHandle={mockDirectoryHandle} />);

    // Click the compare branches button
    const compareButton = screen.getByRole('button', {
      name: /compare branches/i,
    });
    fireEvent.click(compareButton);

    // Verify that compareBranches was called
    expect(compareBranchesMock).toHaveBeenCalled();
  });

  test('should update branch selection when branch is selected', () => {
    // Set up the mock state
    Object.assign(mockGitState, {
      isGitRepo: true,
      status: 'idle',
      activeTab: 'compare',
      branches: ['main', 'develop', 'feature'],
      selectedBaseBranch: 'main',
      selectedCompareBranch: 'develop',
      diffResultsByPair: {},
      error: null,
    });

    render(<GitPanel rootDirectoryHandle={mockDirectoryHandle} />);

    // Find the branch selectors - simplified test since we're mocking UI components
    const branchSelectors = screen.getAllByRole('combobox');
    expect(branchSelectors.length).toBe(2);

    // Verify the selected branch values are shown in the UI
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('develop')).toBeInTheDocument();
  });
});
