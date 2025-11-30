import { Label, Switch } from '@brainstrike/ui';
import type React from 'react';

type IncludeProjectTreeSettingProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
};

const IncludeProjectTreeSetting: React.FC<IncludeProjectTreeSettingProps> = ({
  checked,
  onChange,
}) => (
  <div className="flex items-center space-x-2">
    <Switch checked={checked} id="include-project-tree" onCheckedChange={onChange} />
    <Label htmlFor="include-project-tree">Include Project Tree</Label>
  </div>
);

export default IncludeProjectTreeSetting;
