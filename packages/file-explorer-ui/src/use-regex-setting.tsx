import { Label, Switch } from '@brainstrike/ui';
import type React from 'react';
import { useId } from 'react';

interface UseRegexSettingProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const UseRegexSetting: React.FC<UseRegexSettingProps> = ({ checked, onChange }) => {
  const useRegexId = useId();

  return (
    <div className="flex items-center space-x-2">
      <Switch id={useRegexId} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={useRegexId}>Use Regex Filters</Label>
    </div>
  );
};

export default UseRegexSetting;
