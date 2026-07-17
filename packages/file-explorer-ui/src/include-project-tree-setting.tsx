import { Label, Switch } from '@brainstrike/ui';

interface IncludeProjectTreeSettingProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const IncludeProjectTreeSetting = ({ checked, onChange }: IncludeProjectTreeSettingProps) => (
  <div className="flex items-center space-x-2">
    <Switch
      aria-label="Include Project Tree"
      checked={checked}
      id="include-project-tree"
      onCheckedChange={onChange}
    />
    <Label className="cursor-pointer select-none" htmlFor="include-project-tree">
      <span className="@[600px]:inline hidden">Include Project Tree</span>
      <span className="@[450px]:inline @[600px]:hidden hidden">Project Tree</span>
      <span className="inline @[450px]:hidden">Tree</span>
    </Label>
  </div>
);

export default IncludeProjectTreeSetting;
