// Sibling components below use relative paths, never this package's own
// `@brainstrike/ui` barrel — that would close a source cycle. See the fuller
// note in error-boundary.tsx (BST-890).

import { Monitor, Moon, Sun } from 'lucide-react';
import { type ComponentType, type ReactNode, useId } from 'react';
import { Button } from './button';
import { Input } from './input';
import { cn } from './lib/utils';
import { type ThemeMode, useTheme } from './theme-provider';
import {
  CODE_FONT_SIZES,
  CODE_FONTS,
  CODE_THEMES,
  type CodeThemeId,
  FONTS,
  type FontDefinition,
  MOTION_PREFERENCES,
  THEMES,
  type ThemeDefinition,
  TRANSCRIPT_TEXT_SIZES,
  TRANSCRIPT_WIDTHS,
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

/**
 * A compact single-row radio group for short text choices (sizes, widths),
 * with the same native-radio keyboard model as {@link ChoiceGroup}.
 */
function SegmentedChoice<Id extends string>({
  description,
  label,
  onChange,
  options,
  testIdPrefix,
  value,
}: {
  description: string;
  label: string;
  onChange: (id: Id) => void;
  options: readonly { readonly id: Id; readonly label: string }[];
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
        className="border-border bg-muted/40 inline-flex flex-wrap gap-1 rounded-lg border p-1"
        role="radiogroup"
      >
        {options.map((option) => (
          <label
            className={cn(
              'has-[:focus-visible]:ring-ring cursor-pointer rounded-md px-3 py-1 text-sm transition-colors has-[:focus-visible]:ring-2',
              value === option.id
                ? 'bg-primary text-primary-foreground font-medium shadow-xs'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
            data-testid={`${testIdPrefix}-${option.id}`}
            key={option.id}
          >
            <input
              checked={value === option.id}
              className="sr-only"
              name={groupName}
              onChange={() => onChange(option.id)}
              type="radio"
              value={option.id}
            />
            {option.label}
          </label>
        ))}
      </div>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

/** Code font size options; `default` stands for no chosen size. */
const CODE_FONT_SIZE_OPTIONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'default', label: 'Default' },
  ...CODE_FONT_SIZES.map((size) => ({ id: String(size), label: `${size}px` })),
];

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

/** Diff tints that read on any scheme's background, light or dark. */
const REMOVED_ROW = 'rgba(248, 81, 73, 0.16)';
const ADDED_ROW = 'rgba(46, 160, 67, 0.18)';

function PreviewRow({
  children,
  kind,
  line,
}: {
  children: ReactNode;
  kind?: 'added' | 'removed';
  line: number;
}) {
  return (
    <div
      className="flex border-l-2 px-2 whitespace-pre"
      style={{
        backgroundColor:
          kind === 'added' ? ADDED_ROW : kind === 'removed' ? REMOVED_ROW : undefined,
        borderLeftColor:
          kind === 'added'
            ? 'rgb(46, 160, 67)'
            : kind === 'removed'
              ? 'rgb(248, 81, 73)'
              : 'transparent',
      }}
    >
      <span className="w-6 shrink-0 text-right" style={{ color: 'var(--syntax-comment)' }}>
        {line}
      </span>
      <span className="pl-3">{children}</span>
    </div>
  );
}

/**
 * A small diff painted with one code theme on its own background. The
 * `data-code-theme-light`/`-dark` attribute scopes code-themes.css to the
 * preview, and the dark preview carries `.dark`, so each shows its scheme
 * whatever mode the app is in.
 */
function CodeThemeDiffPreview({
  codeTheme,
  scheme,
}: {
  codeTheme: CodeThemeId;
  scheme: 'dark' | 'light';
}) {
  const keyword = { color: 'var(--syntax-keyword)' };
  const string = { color: 'var(--syntax-string)' };
  const attributes =
    scheme === 'dark'
      ? { 'data-code-theme-dark': codeTheme }
      : { 'data-code-theme-light': codeTheme };
  return (
    <div
      aria-hidden="true"
      className={cn(
        'border-border overflow-hidden rounded-md border py-1.5 font-mono text-xs leading-relaxed',
        scheme === 'dark' && 'dark'
      )}
      data-testid={`code-theme-preview-${scheme}`}
      style={{ backgroundColor: 'var(--syntax-background)', color: 'var(--syntax-foreground)' }}
      {...attributes}
    >
      <PreviewRow line={1}>
        <span style={keyword}>function</span>{' '}
        <span style={{ color: 'var(--syntax-function)' }}>greet</span>
        (name: <span style={{ color: 'var(--syntax-type)' }}>string</span>) {'{'}
      </PreviewRow>
      <PreviewRow kind="removed" line={2}>
        {'  '}
        <span style={keyword}>return</span> <span style={string}>{'"Hello, "'}</span>
        {' + name;'}
      </PreviewRow>
      <PreviewRow kind="added" line={2}>
        {'  '}
        <span style={keyword}>return</span> <span style={string}>{'`Hello, ${'}</span>
        {'name'}
        <span style={string}>{'}!`'}</span>
        {';'}
      </PreviewRow>
      <PreviewRow line={3}>{'}'}</PreviewRow>
    </div>
  );
}

/** One mode's code theme: a select and a diff preview of the chosen theme. */
function CodeThemePicker({
  onChange,
  scheme,
  value,
}: {
  onChange: (id: CodeThemeId) => void;
  scheme: 'dark' | 'light';
  value: CodeThemeId;
}) {
  const selectId = useId();
  return (
    <div className="min-w-0 space-y-2">
      <label className="text-muted-foreground text-sm" htmlFor={selectId}>
        {scheme === 'dark' ? 'Dark mode' : 'Light mode'}
      </label>
      <select
        className="border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-hidden focus-visible:ring-[3px]"
        id={selectId}
        onChange={(event) => {
          const next = CODE_THEMES.find((theme) => theme.id === event.target.value);
          if (next) {
            onChange(next.id);
          }
        }}
        value={value}
      >
        {CODE_THEMES.map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.label}
          </option>
        ))}
      </select>
      <CodeThemeDiffPreview codeTheme={value} scheme={scheme} />
    </div>
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
    codeFontSize,
    codeThemeDark,
    codeThemeLight,
    customCodeFont,
    font,
    mode,
    motion,
    setCodeFont,
    setCodeFontSize,
    setCodeThemeDark,
    setCodeThemeLight,
    setCustomCodeFont,
    setFont,
    setMode,
    setMotion,
    setTheme,
    setTranscriptTextSize,
    setTranscriptWidth,
    theme,
    transcriptTextSize,
    transcriptWidth,
  } = useTheme();
  const customCodeFontId = useId();

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
      <SegmentedChoice
        description="The size of messages in chat."
        label="Transcript text size"
        onChange={setTranscriptTextSize}
        options={TRANSCRIPT_TEXT_SIZES}
        testIdPrefix="transcript-size"
        value={transcriptTextSize}
      />
      <SegmentedChoice
        description="Narrow keeps chat in a reading column, Wide caps it on a wide panel, Full uses the whole panel."
        label="Transcript width"
        onChange={setTranscriptWidth}
        options={TRANSCRIPT_WIDTHS}
        testIdPrefix="transcript-width"
        value={transcriptWidth}
      />
      <SegmentedChoice
        description="Reduced turns off animations and smooth scrolling. System follows your device setting."
        label="Motion"
        onChange={setMotion}
        options={MOTION_PREFERENCES}
        testIdPrefix="motion"
        value={motion}
      />
      <ChoiceGroup
        description="The typeface for the editor, diffs, code in chat and the terminal."
        label="Code font"
        onChange={setCodeFont}
        options={CODE_FONTS}
        renderOption={(id) => <FontPreview font={byId(CODE_FONTS, id)} sample="{0O1l}" />}
        testIdPrefix="code-font-card"
        value={codeFont}
      />
      <div className="space-y-2">
        <label className="block text-sm leading-none font-medium" htmlFor={customCodeFontId}>
          Custom code font
        </label>
        <Input
          autoComplete="off"
          className="max-w-xs"
          id={customCodeFontId}
          onChange={(event) => setCustomCodeFont(event.target.value)}
          placeholder="e.g. Berkeley Mono"
          spellCheck={false}
          value={customCodeFont}
        />
        <p className="text-muted-foreground text-sm">
          A monospace font installed on this computer, used for code and the terminal. If it is
          missing, the code font above is used.
        </p>
      </div>
      <SegmentedChoice
        description="Applies to the editor, diffs, code in chat and the terminal. Default keeps each one's own size."
        label="Code font size"
        onChange={(id) =>
          setCodeFontSize(
            id === 'default' ? null : (CODE_FONT_SIZES.find((size) => String(size) === id) ?? null)
          )
        }
        options={CODE_FONT_SIZE_OPTIONS}
        testIdPrefix="code-font-size"
        value={codeFontSize === null ? 'default' : String(codeFontSize)}
      />
      <div className="space-y-2">
        <p className="text-sm leading-none font-medium">Code theme</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <CodeThemePicker onChange={setCodeThemeLight} scheme="light" value={codeThemeLight} />
          <CodeThemePicker onChange={setCodeThemeDark} scheme="dark" value={codeThemeDark} />
        </div>
        <p className="text-muted-foreground text-sm">
          Syntax colors for the editor, diffs and code in chat, chosen separately for light and dark
          mode.
        </p>
      </div>
    </div>
  );
}
