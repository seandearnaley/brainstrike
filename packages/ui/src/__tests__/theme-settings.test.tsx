import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../theme-provider';
import { ThemeSettings } from '../theme-settings';
import { CODE_FONTS, CODE_THEMES, FONTS, THEMES } from '../themes';

vi.mock('../theme-provider', () => ({
  useTheme: vi.fn(),
}));

describe('ThemeSettings', () => {
  const setCodeFont = vi.fn();
  const setCodeFontSize = vi.fn();
  const setCodeTheme = vi.fn();
  const setCustomCodeFont = vi.fn();
  const setFont = vi.fn();
  const setMode = vi.fn();
  const setMotion = vi.fn();
  const setTheme = vi.fn();
  const setTranscriptTextSize = vi.fn();
  const setTranscriptWidth = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useTheme as ReturnType<typeof vi.fn>).mockReturnValue({
      codeFont: 'geist-mono',
      codeFontSize: null,
      codeTheme: 'classic',
      customCodeFont: '',
      font: 'geist',
      mode: 'light',
      motion: 'system',
      setCodeFont,
      setCodeFontSize,
      setCodeTheme,
      setCustomCodeFont,
      setFont,
      setMode,
      setMotion,
      setTheme,
      setTranscriptTextSize,
      setTranscriptWidth,
      theme: 'brainstrike',
      transcriptTextSize: 'medium',
      transcriptWidth: 'wide',
    });
  });

  it('renders the mode buttons and highlights the active one', () => {
    render(<ThemeSettings />);
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls setMode with the clicked mode', () => {
    render(<ThemeSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(setMode).toHaveBeenCalledWith('dark');
  });

  it('renders one theme card per registry entry inside a radiogroup', () => {
    render(<ThemeSettings />);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(within(group).getAllByRole('radio')).toHaveLength(THEMES.length);
    for (const theme of THEMES) {
      expect(group).toContainElement(screen.getByRole('radio', { name: theme.label }));
    }
  });

  it('puts each picker in ONE native radio group, which is what gives arrow keys and a single tab stop', () => {
    render(<ThemeSettings />);
    const groupNames = screen.getAllByRole('radiogroup').map((group) => {
      const names = new Set(
        within(group)
          .getAllByRole('radio')
          .map((card) => card.getAttribute('name'))
      );
      expect(names.size).toBe(1);
      const [name] = names;
      expect(name).toBeTruthy();
      return name;
    });
    // Eight pickers, and no two share a group.
    expect(new Set(groupNames).size).toBe(8);
  });

  it.each([
    ['Interface font', FONTS, 'geist', 'inter', setFont],
    ['Code font', CODE_FONTS, 'geist-mono', 'jetbrains-mono', setCodeFont],
    ['Code theme', CODE_THEMES, 'classic', 'catppuccin', setCodeTheme],
  ] as const)(
    '%s offers every registry entry and switches on click',
    (label, registry, active, next, setter) => {
      render(<ThemeSettings />);
      const group = within(screen.getByRole('radiogroup', { name: label }));
      expect(group.getAllByRole('radio')).toHaveLength(registry.length);
      const label_ = (id: string) => registry.find((entry) => entry.id === id)?.label ?? id;
      expect(group.getByRole('radio', { name: label_(active) })).toBeChecked();
      fireEvent.click(group.getByRole('radio', { name: label_(next) }));
      expect(setter).toHaveBeenCalledWith(next);
    }
  );

  it.each([
    ['Transcript text size', 'Medium', 'Large', setTranscriptTextSize, 'large'],
    ['Transcript width', 'Wide', 'Narrow', setTranscriptWidth, 'narrow'],
    ['Motion', 'System', 'Reduced', setMotion, 'reduced'],
    ['Code font size', 'Default', '15px', setCodeFontSize, 15],
  ] as const)(
    '%s shows the current choice and switches on click',
    (label, active, next, setter, value) => {
      render(<ThemeSettings />);
      const group = within(screen.getByRole('radiogroup', { name: label }));
      expect(group.getByRole('radio', { name: active })).toBeChecked();
      fireEvent.click(group.getByRole('radio', { name: next }));
      expect(setter).toHaveBeenCalledWith(value);
    }
  );

  it("goes back to each surface's own code size when Default is picked", () => {
    vi.mocked(useTheme).mockReturnValue({
      ...vi.mocked(useTheme)(),
      codeFontSize: 15,
    });
    render(<ThemeSettings />);
    const group = within(screen.getByRole('radiogroup', { name: 'Code font size' }));
    expect(group.getByRole('radio', { name: '15px' })).toBeChecked();
    fireEvent.click(group.getByRole('radio', { name: 'Default' }));
    expect(setCodeFontSize).toHaveBeenCalledWith(null);
  });

  it('saves a custom code font as it is typed', () => {
    render(<ThemeSettings />);
    fireEvent.change(screen.getByLabelText('Custom code font'), {
      target: { value: 'Berkeley Mono' },
    });
    expect(setCustomCodeFont).toHaveBeenCalledWith('Berkeley Mono');
  });

  it('previews each font in its own typeface', () => {
    render(<ThemeSettings />);
    const inter = FONTS.find((font) => font.id === 'inter');
    expect(inter).toBeDefined();
    const card = screen.getByTestId('font-card-inter');
    expect(card.querySelector('[style]')).toHaveStyle({ fontFamily: inter?.family });
  });

  it('scopes each code theme preview to its own theme', () => {
    render(<ThemeSettings />);
    const card = screen.getByTestId('code-theme-card-solarized');
    expect(card.querySelector('[data-code-theme="solarized"]')).not.toBeNull();
  });

  it('marks the active theme card checked and switches on click', () => {
    render(<ThemeSettings />);
    expect(screen.getByRole('radio', { name: 'Brainstrike' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Tide' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Tide' }));
    expect(setTheme).toHaveBeenCalledWith('tide');
  });

  it('pairs the hover surface with its foreground so a bold-accent palette stays legible', () => {
    render(<ThemeSettings />);
    // Tide is not the active card here, so it carries the idle hover treatment.
    expect(screen.getByTestId('theme-card-tide')).toHaveClass(
      'hover:bg-accent',
      'hover:text-accent-foreground'
    );
  });

  it('paints each card swatch from the registry', () => {
    render(<ThemeSettings />);
    const ember = THEMES.find((t) => t.id === 'ember');
    // `toHaveStyle({ backgroundColor: undefined })` passes vacuously, so prove
    // the registry entry exists before asserting against it.
    expect(ember).toBeDefined();
    const swatch = screen.getByTestId('theme-swatch-ember-light-primary');
    expect(swatch).toHaveStyle({ backgroundColor: ember?.swatch.light.primary });
  });

  it('renders the mode icons', () => {
    render(<ThemeSettings />);
    expect(screen.getByTestId('light-theme-icon')).toBeInTheDocument();
    expect(screen.getByTestId('dark-theme-icon')).toBeInTheDocument();
    expect(screen.getByTestId('system-theme-icon')).toBeInTheDocument();
  });
});
