import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { debounce } from 'lodash';
import { AlertCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '../../components/ui/input';
const FileExtensionFilter = ({ includeFilters, excludeFilters, onFilterChange, useRegex, filterError, }) => {
    const [includeInput, setIncludeInput] = useState(() => includeFilters.join(', '));
    const [excludeInput, setExcludeInput] = useState(() => excludeFilters.join(', '));
    const isFirstMount = useRef(true);
    useEffect(() => {
        if (!isFirstMount.current)
            return;
        isFirstMount.current = false;
        setIncludeInput(includeFilters.join(', '));
        setExcludeInput(excludeFilters.join(', '));
    }, [includeFilters, excludeFilters]);
    const debouncedFilterChange = useMemo(() => debounce((newInclude, newExclude) => {
        onFilterChange(newInclude, newExclude, useRegex);
    }, 300), [onFilterChange, useRegex]);
    const handleInputChange = (value, setInput, otherFilters, isInclude) => {
        setInput(value);
        const newFilters = value
            .split(',')
            .map((f) => f.trim())
            .filter(Boolean);
        debouncedFilterChange(isInclude ? newFilters : otherFilters, isInclude ? otherFilters : newFilters);
    };
    const handleIncludeInputChange = (e) => {
        handleInputChange(e.target.value, setIncludeInput, excludeFilters, true);
    };
    const handleExcludeInputChange = (e) => {
        handleInputChange(e.target.value, setExcludeInput, includeFilters, false);
    };
    const getPlaceholder = (isInclude) => useRegex
        ? 'Enter regex patterns, separated by commas'
        : isInclude
            ? 'e.g. *.ts, src/**/*.js'
            : 'e.g. *.test.js, node_modules/**';
    return (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { children: [_jsx("label", { htmlFor: "include-files", className: "text-sm font-medium", children: "Files to Include:" }), _jsx(Input, { id: "include-files", type: "text", value: includeInput, onChange: handleIncludeInputChange, placeholder: getPlaceholder(true) })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "exclude-files", className: "text-sm font-medium", children: "Files to Exclude:" }), _jsx(Input, { id: "exclude-files", type: "text", value: excludeInput, onChange: handleExcludeInputChange, placeholder: getPlaceholder(false) })] }), filterError && (_jsxs("div", { className: "flex items-center text-red-600 text-sm mt-1", children: [_jsx(AlertCircle, { className: "mr-1 h-4 w-4" }), filterError] }))] }));
};
export default FileExtensionFilter;
