// Sibling components below use relative paths, never this package's own
// `@brainstrike/ui` barrel — that would close a source cycle. See the fuller
// note in error-boundary.tsx (BST-890).

import { Monitor, Moon, Sun } from 'lucide-react';
import { type ComponentType, type ReactNode, useId } from 'react';
import { Button } from './button';
import { cn } from './lib/utils';
import { type ThemeMode, useTheme } from './theme-provider';
import {
  CODE_FONTS,
  CODE_THEMES,
  type CodeThemeDefinition,
  FONTS,
  type FontDefinition,
  THEMES,
  type ThemeDefinition,
} from './themes';

const MODE_OPTIONS: ReadonlyArray<{
  icon: ComponentType<{ className?: string; 'data-testid'?: string }>;
  label: string;
  mode: ThemeMode;
  testId: string;
}> = [
  { icon: Sun, label: 'Light', mode: 'light', testId: 'light-theme-icon' },
  { icon: Moon, label: 'Dark', mode: 'dark', testId: 'dark-theme-icon' },
  { icon: Monitor, label: 'System', mode: 'system', testId: 'system-theme-icon' },
];

function Swatch({ color, testId }: { color: string; testId: string }) {
  return (
    <span
      aria-hidden="true"
      className="border-border inline-block size-4 rounded-sm border"
      data-testid={testId}
      style={{ backgroundColor: color }}
    />
  );
}

/**
 * One choice card: a NATIVE radio, visually hidden, inside a label that paints
 * the preview. The browser then supplies the whole radio-group keyboard model
 * (one tab stop on the checked card, arrows move AND select with wrap-around,
 * Space selects) — a hand-rolled keydown handler would only re-implement it,
 * worse. Same pattern as `threads-panel-view-options.tsx`; the shared `name`
 * is what makes the browser treat the cards as ONE group.
 */
function ChoiceCard({
  active,
  children,
  groupName,
  onSelect,
  testId,
  value,
}: {
  active: boolean;
  children: ReactNode;
  groupName: string;
  onSelect: () => void;
  testId: string;
  value: string;
}) {
  return (
    <label
      className={cn(
        'has-[:focus-visible]:ring-ring flex cursor-pointer flex-col gap-2 rounded-lg border p-3 text-left transition-colors has-[:focus-visible]:ring-2',
        active
          ? 'border-primary ring-ring/50 ring-2'
          : 'border-border hover:bg-accent hover:text-accent-foreground'
      )}
      data-testid={testId}
    >
      <input
        checked={active}
        className="sr-only"
        name={groupName}
        onChange={onSelect}
        type="radio"
        value={value}
      />
      {children}
    </label>
  );
}

/** A labelled radio group of {@link ChoiceCard}s. */
function ChoiceGroup<Id extends string>({
  description,
  label,
  onChange,
  options,
  renderOption,
  testIdPrefix,
  value,
}: {
  description: string;
  label: string;
  onChange: (id: Id) => void;
  options: readonly { readonly id: Id }[];
  renderOption: (id: Id) => ReactNode;
  testIdPrefix: string;
  value: Id;
}) {
  const groupName = useId();
  const labelId = useId();
  return (
    <div className="space-y-2">
      <p className="text-sm leading-none font-medium" id={labelId}>
        {label}
      </p>
      <div
        aria-labelledby={labelId}
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        role="radiogroup"
      >
        {options.map(({ id }) => (
          <ChoiceCard
            active={value === id}
            groupName={groupName}
            key={id}
            onSelect={() => onChange(id)}
            testId={`${testIdPrefix}-${id}`}
            value={id}
          >
            {renderOption(id)}
          </ChoiceCard>
        ))}
      </div>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

function ThemePreview({ theme }: { theme: ThemeDefinition }) {
  return (
    <>
      <span className="flex gap-1">
        <Swatch
          color={theme.swatch.light.background}
          testId={`theme-swatch-${theme.id}-light-background`}
        />
        <Swatch
          color={theme.swatch.light.primary}
          testId={`theme-swatch-${theme.id}-light-primary`}
        />
        <Swatch
          color={theme.swatch.dark.background}
          testId={`theme-swatch-${theme.id}-dark-background`}
        />
        <Swatch
          color={theme.swatch.dark.primary}
          testId={`theme-swatch-${theme.id}-dark-primary`}
        />
      </span>
      <span className="text-sm font-medium">{theme.label}</span>
    </>
  );
}

function FontPreview({ font, sample }: { font: FontDefinition<string>; sample: string }) {
  return (
    <span className="flex flex-col gap-1" style={{ fontFamily: font.family }}>
      <span aria-hidden="true" className="text-muted-foreground text-lg leading-none">
        {sample}
      </span>
      <span className="text-sm font-medium">{font.label}</span>
    </span>
  );
}

/**
 * A few tokens painted with the `--syntax-*` colours. `data-code-theme` on the
 * preview scopes code-themes.css to this card, so each card shows its own
 * scheme in the current light or dark mode.
 */
function CodeThemePreview({ codeTheme }: { codeTheme: CodeThemeDefinition }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="bg-background border-border block rounded-sm border px-2 py-1 font-mono text-xs leading-snug"
        data-code-theme={codeTheme.id}
      >
        <span style={{ color: 'var(--syntax-keyword)' }}>const</span>{' '}
        <span style={{ color: 'var(--syntax-function)' }}>greet</span> ={' '}
        <span style={{ color: 'var(--syntax-string)' }}>&quot;hi&quot;</span>
        <br />
        <span style={{ color: 'var(--syntax-comment)', fontStyle: 'italic' }}>
          {'// '}
          <span style={{ color: 'var(--syntax-number)', fontStyle: 'normal' }}>42</span>
        </span>
      </span>
      <span className="text-sm font-medium">{codeTheme.label}</span>
    </>
  );
}

function byId<Definition extends { readonly id: string }>(
  definitions: readonly Definition[],
  id: Definition['id']
): Definition {
  const definition = definitions.find((candidate) => candidate.id === id);
  if (!definition) {
    throw new Error(`Unknown appearance option: ${id}`);
  }
  return definition;
}

export function ThemeSettings() {
  const {
    codeFont,
    codeTheme,
    font,
    mode,
    setCodeFont,
    setCodeTheme,
    setFont,
    setMode,
    setTheme,
    theme,
  } = useTheme();

  return (
    <div className="grid gap-6">
      <div className="space-y-2">
        <p className="text-sm leading-none font-medium">Mode</p>
        <div className="grid grid-cols-3 gap-4">
          {MODE_OPTIONS.map(({ icon: Icon, label, mode: option, testId }) => (
            <Button
              aria-pressed={mode === option}
              className="w-full"
              key={option}
              onClick={() => setMode(option)}
              variant={mode === option ? 'default' : 'outline'}
            >
              <Icon className="mr-2 h-5 w-5" data-testid={testId} />
              {label}
            </Button>
          ))}
        </div>
        <p className="text-muted-foreground text-sm">
          Light, dark, or follow your device setting. Every theme below has both a light and a dark
          look.
        </p>
      </div>
      <ChoiceGroup
        description="Pick a color palette for the interface."
        label="Theme"
        onChange={setTheme}
        options={THEMES}
        renderOption={(id) => <ThemePreview theme={byId(THEMES, id)} />}
        testIdPrefix="theme-card"
        value={theme}
      />
      <ChoiceGroup
        description="The typeface for menus, panels and chat."
        label="Interface font"
        onChange={setFont}
        options={FONTS}
        renderOption={(id) => <FontPreview font={byId(FONTS, id)} sample="Aa" />}
        testIdPrefix="font-card"
        value={font}
      />
      <ChoiceGroup
        description="The typeface for the editor, diffs and code in chat."
        label="Code font"
        onChange={setCodeFont}
        options={CODE_FONTS}
        renderOption={(id) => <FontPreview font={byId(CODE_FONTS, id)} sample="{0O1l}" />}
        testIdPrefix="code-font-card"
        value={codeFont}
      />
      <ChoiceGroup
        description="Syntax colors for the editor, diffs and code in chat. Each follows the light or dark mode."
        label="Code theme"
        onChange={setCodeTheme}
        options={CODE_THEMES}
        renderOption={(id) => <CodeThemePreview codeTheme={byId(CODE_THEMES, id)} />}
        testIdPrefix="code-theme-card"
        value={codeTheme}
      />
    </div>
  );
}
