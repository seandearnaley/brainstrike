import { Label, Switch } from '@brainstrike/ui';
import type React from 'react';
import { useId } from 'react';

interface IncludeProjectTreeSettingProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const IncludeProjectTreeSetting: React.FC<IncludeProjectTreeSettingProps> = ({
  checked,
  onChange,
}) => {
  const includeProjectTreeId = useId();

  return (
    <div className="flex items-center space-x-2">
      <Switch id={includeProjectTreeId} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={includeProjectTreeId}>Include Project Tree</Label>
    </div>
  );
};

export default IncludeProjectTreeSetting;
