import { Command } from 'cmdk';

export function ModelPickerEmpty() {
  return (
    <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
      No models found.
    </Command.Empty>
  );
}
