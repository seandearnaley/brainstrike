import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Label } from '../../components/ui/label';
import { Switch } from '../../components/ui/switch';
const IncludeProjectTreeSetting = ({ checked, onChange, }) => (_jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(Switch, { id: "include-project-tree", checked: checked, onCheckedChange: onChange }), _jsx(Label, { htmlFor: "include-project-tree", children: "Include Project Tree" })] }));
export default IncludeProjectTreeSetting;
