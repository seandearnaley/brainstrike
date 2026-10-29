import { Command } from 'cmdk';

export function ModelPickerEmpty() {
  return (
    <Command.Empty className="text-muted-foreground py-6 text-center text-sm">
      No models found.
    </Command.Empty>
  );
}
