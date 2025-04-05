import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Label } from '../../components/ui/label';
const FolderSummaryThresholdSetting = ({ value, onChange, }) => (_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "folder-summary-threshold", children: "Folder Summary Threshold" }), _jsx("input", { type: "number", id: "folder-summary-threshold", min: "0", value: value, onChange: (e) => onChange(Number.parseInt(e.target.value, 10)), className: "w-full px-3 py-2 border rounded-md bg-background text-foreground" }), _jsx("p", { className: "text-sm text-muted-foreground", children: "Number of files to show before summarizing folder contents (0 to show all)" })] }));
export default FolderSummaryThresholdSetting;
