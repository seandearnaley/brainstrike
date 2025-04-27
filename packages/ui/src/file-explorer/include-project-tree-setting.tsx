import type { FC } from 'react';
import { Label } from '../label';
import { Switch } from '../switch';

export interface IncludeProjectTreeSettingProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const IncludeProjectTreeSetting: FC<IncludeProjectTreeSettingProps> = ({ checked, onChange }) => (
  <div className="flex items-center space-x-2">
    <Switch id="include-project-tree" checked={checked} onCheckedChange={onChange} />
    <Label htmlFor="include-project-tree">Include Project Tree</Label>
  </div>
);

export default IncludeProjectTreeSetting;
