import { Label } from '@brainstrike/ui';
import { Switch } from '@brainstrike/ui';
import type React from 'react';

interface IncludeProjectTreeSettingProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const IncludeProjectTreeSetting: React.FC<IncludeProjectTreeSettingProps> = ({
  checked,
  onChange,
}) => (
  <div className="flex items-center space-x-2">
    <Switch id="include-project-tree" checked={checked} onCheckedChange={onChange} />
    <Label htmlFor="include-project-tree">Include Project Tree</Label>
  </div>
);

export default IncludeProjectTreeSetting;
