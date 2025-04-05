import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Label } from '../../components/ui/label';
const MaxSelectionCountSetting = ({ value, onChange }) => (_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "max-selection-count", children: "Max Selection Count" }), _jsx("input", { type: "number", id: "max-selection-count", min: "0", value: value, onChange: (e) => onChange(Number.parseInt(e.target.value, 10)), className: "w-full px-3 py-2 border rounded-md bg-background text-foreground" }), _jsx("p", { className: "text-sm text-muted-foreground", children: "Maximum number of files that can be selected at once" })] }));
export default MaxSelectionCountSetting;
