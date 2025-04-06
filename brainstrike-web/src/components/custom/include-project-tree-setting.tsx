import type React from 'react';
import { Label } from '../../components/ui/label';
import { Switch } from '../../components/ui/switch';

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
