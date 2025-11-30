import { Command } from 'cmdk';

export function ModelPickerEmpty() {
  return (
    <Command.Empty className="py-6 text-center text-muted-foreground text-sm">
      No models found.
    </Command.Empty>
  );
}
