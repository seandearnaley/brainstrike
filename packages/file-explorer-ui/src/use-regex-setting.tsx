import { Label, Switch } from '@brainstrike/ui';
import type React from 'react';

type UseRegexSettingProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
};

const UseRegexSetting: React.FC<UseRegexSettingProps> = ({ checked, onChange }) => (
  <div className="flex items-center space-x-2">
    <Switch checked={checked} id="use-regex" onCheckedChange={onChange} />
    <Label htmlFor="use-regex">Use Regex Filters</Label>
  </div>
);

export default UseRegexSetting;
