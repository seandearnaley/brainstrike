import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
const UseRegexSetting = ({ checked, onChange }) => (_jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(Switch, { id: "use-regex", checked: checked, onCheckedChange: onChange }), _jsx(Label, { htmlFor: "use-regex", children: "Use Regex Filters" })] }));
export default UseRegexSetting;
