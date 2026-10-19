import { useVectorPreferencesStore } from '@brainstrike/app-state/stores/vector-preferences-store';
import { type DraftInput, Input, Label, useDraftField } from '@brainstrike/ui';
import { useId } from 'react';
import { useShallow } from 'zustand/react/shallow';

interface MemoryNumberFieldProps {
  readonly id: string;
  readonly label: string;
  readonly max: number;
  readonly min: number;
  /** Called only with a whole number inside [min, max]. */
  readonly onValidChange: (value: number) => void;
  readonly step?: number;
  readonly value: number;
}

function rangeMessage(min: number, max: number): string {
  return max === Number.MAX_SAFE_INTEGER
    ? `Enter a whole number of at least ${min.toLocaleString('en-US')}.`
    : `Enter a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`;
}

function wholeNumberIn(draft: DraftInput, min: number, max: number): number | undefined {
  if (draft.badInput || draft.text.trim().length === 0) {
    return;
  }
  const value = Number(draft.text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

/**
 * A memory setting's number input: a draft committed on blur or Enter
 * (`useDraftField`, as Subagent limits do). A whole number in range is saved;
 * anything else is refused under the field and saves nothing, never clamped
 * into range.
 */
export function MemoryNumberField({
  id,
  label,
  max,
  min,
  onValidChange,
  step,
  value,
}: MemoryNumberFieldProps) {
  const field = useDraftField({
    commit: (draft) => {
      const next = wholeNumberIn(draft, min, max);
      if (next === undefined) {
        return rangeMessage(min, max);
      }
      onValidChange(next);
      return;
    },
    value: String(value),
  });
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        aria-describedby={field.error ? `${id}-error` : undefined}
        aria-invalid={field.error ? true : undefined}
        id={id}
        max={max === Number.MAX_SAFE_INTEGER ? undefined : max}
        min={min}
        step={step}
        type="number"
        {...field.inputProps}
      />
      {field.error ? (
        <p className="text-destructive text-xs" id={`${id}-error`} role="alert">
          {field.error}
        </p>
      ) : null}
    </div>
  );
}

const DEVICE_LABEL = 'On-device embedding device';

/**
 * The embedding host's saved device for on-device models (the vector
 * preferences BST-2193 resolves recall's device from). Unconfigured is
 * automatic detection, which uses WebGPU and never selects WASM on its own.
 */
export function OnDeviceEmbeddingDeviceField() {
  const { devicePref, devicePrefConfigured, hasHydrated, setDevicePref } =
    useVectorPreferencesStore(
      useShallow((state) => ({
        devicePref: state.devicePref,
        devicePrefConfigured: state.devicePrefConfigured,
        hasHydrated: state.hasHydrated,
        setDevicePref: state.setDevicePref,
      }))
    );
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{DEVICE_LABEL}</Label>
      <select
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        disabled={!hasHydrated}
        id={id}
        onChange={(event) => {
          const next = event.target.value;
          // Automatic is shown only while it is the saved state, so it is never chosen.
          if (next !== 'webgpu' && next !== 'wasm') {
            throw new Error(`Unknown on-device embedding device: ${next}`);
          }
          setDevicePref(next);
        }}
        value={hasHydrated && devicePrefConfigured ? devicePref : ''}
      >
        {!hasHydrated && <option value="">Loading the saved device…</option>}
        {hasHydrated && !devicePrefConfigured && (
          <option value="">Automatic — WebGPU when this device has it</option>
        )}
        <option value="webgpu">WebGPU</option>
        <option value="wasm">WASM (slower; no GPU needed)</option>
      </select>
      <p className="text-muted-foreground text-xs">
        Where local embedding models run for semantic recall. Automatic never falls back to WASM;
        choose it on a device without WebGPU. Each device embeds at its own precision, so recall
        keeps separate vectors for each.
      </p>
    </div>
  );
}
