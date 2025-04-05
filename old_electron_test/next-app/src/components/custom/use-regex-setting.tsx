'use client';

import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type React from 'react';

interface UseRegexSettingProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const UseRegexSetting: React.FC<UseRegexSettingProps> = ({ checked, onChange }) => (
  <div className="flex items-center space-x-2">
    <Switch id="use-regex" checked={checked} onCheckedChange={onChange} />
    <Label htmlFor="use-regex">Use Regex Filters</Label>
  </div>
);

export default UseRegexSetting;
