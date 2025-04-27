import type { FC } from 'react';
import { Label } from '../label';
import { Switch } from '../switch';

export interface UseRegexSettingProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const UseRegexSetting: FC<UseRegexSettingProps> = ({ checked, onChange }) => (
  <div className="flex items-center space-x-2">
    <Switch id="use-regex" checked={checked} onCheckedChange={onChange} />
    <Label htmlFor="use-regex">Use Regex Filters</Label>
  </div>
);

export default UseRegexSetting;
