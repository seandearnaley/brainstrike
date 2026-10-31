/**
 * The composer's access control: how the assistant's gated tool calls are
 * answered. Ask waits for you, Auto lets a quick model approve what it judges
 * routine and asks about the rest, Full access runs everything. The saved
 * choice belongs to the permission policy owner; this only reads and sets it.
 * When that owner cannot load the saved policy, the chip says so and leads to
 * Settings → Permissions, which explains the failure and offers the fix.
 */
import {
  ACCESS_MODES,
  type AccessMode,
  isAccessMode,
} from '@brainstrike/assistant-contract/tool-metadata';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import {
  ChevronDown,
  Hand,
  type LucideIcon,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
} from 'lucide-react';

export type AccessModeComposerControls =
  | {
      readonly mode: AccessMode;
      readonly onChange: (mode: AccessMode) => void;
    }
  | {
      /** Why the saved policy could not be loaded. */
      readonly unavailable: string;
      readonly onOpenSettings: () => void;
    };

const ACCESS_MODE_OPTIONS: Record<
  AccessMode,
  { readonly description: string; readonly icon: LucideIcon; readonly label: string }
> = {
  ask: {
    description: 'Always ask before editing files or running commands',
    icon: Hand,
    label: 'Ask for approval',
  },
  auto: {
    description: 'A quick model approves routine actions; only asks for risky ones',
    icon: ShieldCheck,
    label: 'Auto',
  },
  full: {
    description: 'Unrestricted: edits files and runs commands without asking',
    icon: ShieldAlert,
    label: 'Full access',
  },
};

export function ComposerAccessModeControl({ access }: { access: AccessModeComposerControls }) {
  if ('unavailable' in access) {
    return (
      <button
        className="bs-composer-chip bs-composer-access"
        data-access-mode="unavailable"
        data-testid="composer-access-mode-trigger"
        onClick={access.onOpenSettings}
        title={`Unable to load permission settings: ${access.unavailable} Open Settings → Permissions.`}
        type="button"
      >
        <ShieldX aria-hidden />
        <span className="sr-only">Access:</span>
        <span className="bs-composer-chip-label bs-composer-collapsible">Unavailable</span>
      </button>
    );
  }
  const current = ACCESS_MODE_OPTIONS[access.mode];
  const Icon = current.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The accessible name keeps the visible label (WCAG 2.5.3); the label
            may collapse visually in a narrow composer. */}
        <button
          className="bs-composer-chip bs-composer-access"
          data-access-mode={access.mode}
          data-testid="composer-access-mode-trigger"
          title={`Access: ${current.label}. ${current.description}`}
          type="button"
        >
          <Icon aria-hidden />
          <span className="sr-only">Access:</span>
          <span className="bs-composer-chip-label bs-composer-collapsible">{current.label}</span>
          <ChevronDown aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[min(22rem,calc(100vw-2rem))] p-1"
        data-testid="composer-access-mode-menu"
        side="top"
        sideOffset={8}
      >
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          How should Brainstrike’s actions be approved?
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={(value) => {
            if (isAccessMode(value)) {
              access.onChange(value);
            }
          }}
          value={access.mode}
        >
          {ACCESS_MODES.map((mode) => {
            const option = ACCESS_MODE_OPTIONS[mode];
            const OptionIcon = option.icon;
            return (
              <DropdownMenuRadioItem
                className="items-start py-2"
                data-access-mode={mode}
                key={mode}
                value={mode}
              >
                <OptionIcon aria-hidden className="mt-0.5" />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{option.label}</span>
                  <span className="text-muted-foreground text-xs">{option.description}</span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
