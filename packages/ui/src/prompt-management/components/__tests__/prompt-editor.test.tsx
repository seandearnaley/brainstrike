import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Category, Prompt } from '../../types';
import { PromptEditor } from '../prompt-editor';

vi.mock('lucide-react', () => ({
  History: () => <span>HistoryIcon</span>,
  Plus: () => <span>Plus</span>,
  RotateCcw: () => <span>RotateCcw</span>,
  Save: () => <span>SaveIcon</span>,
  X: () => <span>X</span>,
}));

vi.mock('../../../badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('../../../button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock('../../../dialog', () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div>
        <button onClick={() => onOpenChange(false)} type="button">
          dialog-dismiss
        </button>
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('../../../expandable-textarea', () => ({
  ExpandableTextarea: ({
    value,
    onChange,
    id,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    id?: string;
    placeholder?: string;
  }) => (
    <textarea
      id={id}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      value={value}
    />
  ),
}));

vi.mock('../../../input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock('../../../label', () => ({
  Label: ({
    children,
    htmlFor,
    ...rest
  }: { children: React.ReactNode; htmlFor?: string } & React.HTMLAttributes<HTMLLabelElement>) => (
    <label htmlFor={htmlFor} {...rest}>
      {children}
    </label>
  ),
}));

vi.mock('../../../model-picker', () => ({
  ModelPicker: ({ onChange, value }: { onChange: (id: string) => void; value: string }) => (
    <div>
      <span>selected-model:{value}</span>
      <button onClick={() => onChange('openai:gpt-4.1-mini')} type="button">
        choose-model
      </button>
    </div>
  ),
}));

vi.mock('../../../scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../select', () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <div>
      <div>{value}</div>
      <button onClick={() => onValueChange('coding')} type="button">
        choose-category-coding
      </button>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}));

const categories: Category[] = [
  { color: '#64748b', icon: 'Box', id: 'general', name: 'General' },
  { color: '#3b82f6', icon: 'Code', id: 'coding', name: 'Coding' },
];

const existingPrompt: Prompt = {
  categoryId: 'coding',
  content: 'Existing content',
  createdAt: 1,
  id: 'prompt-1',
  isFavorite: false,
  modelSettings: {
    frequencyPenalty: 0.1,
    maxTokens: 2048,
    model: 'openai:gpt-4o-mini',
    presencePenalty: 0.2,
    temperature: 0.2,
    topP: 0.8,
  },
  rating: 4,
  revisions: [
    {
      content: 'old-1',
      id: 'rev-1',
      modelSettings: {
        frequencyPenalty: 0.3,
        maxTokens: 4096,
        model: 'openai:gpt-4.1',
        presencePenalty: 0.4,
        temperature: 0.1,
        topP: 0.6,
      },
      timestamp: 1_700_000_000_000,
    },
    { content: 'old-2', id: 'rev-2', timestamp: 1_700_000_100_000 },
  ],
  tags: ['existing-tag', 'legacy'],
  title: 'Existing title',
  updatedAt: 2,
};

describe('PromptEditor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handles create flow, tags, model/category updates, save, and dialog close', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(<PromptEditor categories={categories} isOpen onClose={onClose} onSave={onSave} />);

    expect(screen.getByText('Create New Prompt')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New prompt title' } });
    fireEvent.change(screen.getByLabelText('Prompt Content'), {
      target: { value: 'New prompt content' },
    });
    fireEvent.click(screen.getByText('choose-category-coding'));
    fireEvent.click(screen.getByText('choose-model'));
    fireEvent.change(screen.getByRole('slider'), { target: { value: '1.4' } });

    const tagInput = screen.getByPlaceholderText('Add tag...');
    fireEvent.change(tagInput, { target: { value: 'research' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    fireEvent.change(tagInput, { target: { value: 'research' } });
    fireEvent.click(screen.getByText('Plus'));
    expect(screen.getByText('research')).toBeInTheDocument();

    fireEvent.click(screen.getAllByText('X')[0] as HTMLElement);
    expect(screen.queryByText('research')).not.toBeInTheDocument();

    fireEvent.change(tagInput, { target: { value: 'automation' } });
    fireEvent.click(screen.getByText('Plus'));
    fireEvent.click(screen.getByRole('button', { name: 'SaveIcon Save Prompt' }));

    expect(onSave).toHaveBeenCalledWith({
      categoryId: 'coding',
      content: 'New prompt content',
      modelSettings: {
        model: 'openai:gpt-4.1-mini',
        temperature: 1.4,
        topP: 1,
      },
      tags: ['automation'],
      title: 'New prompt title',
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('dialog-dismiss'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('loads existing prompt values, renders history, and resets when prompt clears', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    const { rerender } = render(
      <PromptEditor
        categories={categories}
        isOpen
        onClose={onClose}
        onSave={onSave}
        prompt={existingPrompt}
      />
    );

    expect(screen.getByText('Edit Prompt')).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Existing title')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Existing content')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('v1')).toBeInTheDocument();

    fireEvent.click(screen.getAllByText('X')[0] as HTMLElement);
    expect(screen.queryByText('existing-tag')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'SaveIcon Save Prompt' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: 'coding',
        content: 'Existing content',
        modelSettings: {
          frequencyPenalty: 0.1,
          maxTokens: 2048,
          model: 'openai:gpt-4o-mini',
          presencePenalty: 0.2,
          temperature: 0.2,
          topP: 0.8,
        },
        title: 'Existing title',
      })
    );

    rerender(<PromptEditor categories={categories} isOpen onClose={onClose} onSave={onSave} />);
    expect(screen.getByText('Create New Prompt')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(screen.getByLabelText('Prompt Content')).toHaveValue('');
    expect(screen.queryByText('History')).not.toBeInTheDocument();
  });

  it('clears an unsaved create draft when the create dialog is reopened', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    const { rerender } = render(
      <PromptEditor categories={categories} isOpen onClose={onClose} onSave={onSave} />
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Stale title' } });
    fireEvent.change(screen.getByLabelText('Prompt Content'), {
      target: { value: 'Stale content' },
    });

    rerender(
      <PromptEditor categories={categories} isOpen={false} onClose={onClose} onSave={onSave} />
    );
    rerender(<PromptEditor categories={categories} isOpen onClose={onClose} onSave={onSave} />);

    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(screen.getByLabelText('Prompt Content')).toHaveValue('');
  });

  it('restores a revision into the editable prompt draft before saving', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(
      <PromptEditor
        categories={categories}
        isOpen
        onClose={onClose}
        onSave={onSave}
        prompt={existingPrompt}
      />
    );

    const restoreButtons = screen.getAllByRole('button', {
      name: 'Restore content and model settings',
    });
    expect(restoreButtons[0]).toHaveAttribute('title', 'Restore content and model settings');

    fireEvent.click(restoreButtons[0] as HTMLElement);

    expect(screen.getByLabelText('Prompt Content')).toHaveValue('old-1');
    expect(screen.getByText('selected-model:openai:gpt-4.1')).toBeInTheDocument();
    expect(screen.getByRole('slider')).toHaveValue('0.1');

    fireEvent.click(screen.getByRole('button', { name: 'SaveIcon Save Prompt' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'old-1',
        modelSettings: {
          frequencyPenalty: 0.3,
          maxTokens: 4096,
          model: 'openai:gpt-4.1',
          presencePenalty: 0.4,
          temperature: 0.1,
          topP: 0.6,
        },
      })
    );
  });

  it('restores legacy revision content without dropping current model settings', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(
      <PromptEditor
        categories={categories}
        isOpen
        onClose={onClose}
        onSave={onSave}
        prompt={existingPrompt}
      />
    );

    fireEvent.click(
      screen.getAllByRole('button', {
        name: 'Restore content and model settings',
      })[1] as HTMLElement
    );

    expect(screen.getByLabelText('Prompt Content')).toHaveValue('old-2');
    expect(screen.getByText('selected-model:openai:gpt-4o-mini')).toBeInTheDocument();
    expect(screen.getByRole('slider')).toHaveValue('0.2');

    fireEvent.click(screen.getByRole('button', { name: 'SaveIcon Save Prompt' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'old-2',
        modelSettings: existingPrompt.modelSettings,
      })
    );
  });

  it('keeps restored drafts across same-prompt rerenders', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    const { rerender } = render(
      <PromptEditor
        categories={categories}
        isOpen
        onClose={onClose}
        onSave={onSave}
        prompt={existingPrompt}
      />
    );

    fireEvent.click(
      screen.getAllByRole('button', {
        name: 'Restore content and model settings',
      })[0] as HTMLElement
    );

    rerender(
      <PromptEditor
        categories={categories}
        isOpen
        onClose={onClose}
        onSave={onSave}
        prompt={{ ...existingPrompt, rating: 5 }}
      />
    );

    expect(screen.getByLabelText('Prompt Content')).toHaveValue('old-1');
    expect(screen.getByText('selected-model:openai:gpt-4.1')).toBeInTheDocument();
  });

  it('does not confirm repeated restore-only changes until the user edits restorable fields', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const confirmRestore = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmRestore);

    render(
      <PromptEditor
        categories={categories}
        isOpen
        onClose={onClose}
        onSave={onSave}
        prompt={existingPrompt}
      />
    );

    const restoreButtons = screen.getAllByRole('button', {
      name: 'Restore content and model settings',
    });

    fireEvent.click(restoreButtons[0] as HTMLElement);
    fireEvent.click(restoreButtons[1] as HTMLElement);
    expect(confirmRestore).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Prompt Content'), {
      target: { value: 'User edit after restore' },
    });
    fireEvent.click(restoreButtons[0] as HTMLElement);

    expect(confirmRestore).toHaveBeenCalledTimes(1);
  });

  it('saves restored content as a normal edit after the user changes it', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(
      <PromptEditor
        categories={categories}
        isOpen
        onClose={onClose}
        onSave={onSave}
        prompt={existingPrompt}
      />
    );

    fireEvent.click(
      screen.getAllByRole('button', {
        name: 'Restore content and model settings',
      })[0] as HTMLElement
    );
    fireEvent.change(screen.getByLabelText('Prompt Content'), {
      target: { value: 'User edit after restore' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'SaveIcon Save Prompt' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.not.objectContaining({
        revisionNote: 'Before restore',
      })
    );
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'User edit after restore',
      })
    );
  });

  it('confirms before restoring over dirty restorable draft fields', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const confirmRestore = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirmRestore);

    render(
      <PromptEditor
        categories={categories}
        isOpen
        onClose={onClose}
        onSave={onSave}
        prompt={existingPrompt}
      />
    );

    fireEvent.change(screen.getByLabelText('Prompt Content'), {
      target: { value: 'Unsaved draft content' },
    });

    const restoreButton = screen.getAllByRole('button', {
      name: 'Restore content and model settings',
    })[0] as HTMLElement;

    fireEvent.click(restoreButton);
    expect(confirmRestore).toHaveBeenCalledWith(
      "Restore this version's content and model settings? Unsaved draft edits will be replaced. Title, category, and tags stay unchanged."
    );
    expect(screen.getByLabelText('Prompt Content')).toHaveValue('Unsaved draft content');

    fireEvent.click(restoreButton);
    expect(screen.getByLabelText('Prompt Content')).toHaveValue('old-1');

    fireEvent.click(screen.getByRole('button', { name: 'SaveIcon Save Prompt' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'old-1',
        revisionNote: 'Before restore',
      })
    );
  });
});
