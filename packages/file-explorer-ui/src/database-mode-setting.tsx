import { Label, Switch } from '@brainstrike/ui';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@brainstrike/ui';
import { Database, HardDrive, Info } from 'lucide-react';

interface DatabaseModeSettingProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

const DatabaseModeSetting: React.FC<DatabaseModeSettingProps> = ({
  checked,
  onChange,
  disabled = false,
}) => {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Label htmlFor="database-mode" className="text-sm font-medium cursor-pointer">
            Database Mode
          </Label>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3 w-3 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <div className="space-y-2">
                  <p className="font-medium">Database vs File System Mode</p>
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center space-x-2">
                      <Database className="h-3 w-3 text-blue-500" />
                      <span>
                        <strong>Database:</strong> Files loaded into local database for faster
                        access
                      </span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <HardDrive className="h-3 w-3 text-gray-500" />
                      <span>
                        <strong>File System:</strong> Direct file access from disk
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Database mode provides better performance and enables workspace persistence
                    across browser sessions.
                  </p>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <Switch
          id="database-mode"
          checked={checked}
          onCheckedChange={onChange}
          disabled={disabled}
          data-testid="database-mode-switch"
        />
      </div>

      <div className="flex items-center space-x-2 text-xs text-muted-foreground">
        {checked ? (
          <>
            <Database className="h-3 w-3 text-blue-500" />
            <span>Files will be loaded into local database</span>
          </>
        ) : (
          <>
            <HardDrive className="h-3 w-3 text-gray-500" />
            <span>Files will be accessed directly from disk</span>
          </>
        )}
      </div>
    </div>
  );
};

export default DatabaseModeSetting;
