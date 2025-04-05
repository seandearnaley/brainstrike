import { useCallback, useMemo, useState } from 'react';
import { useDebouncedValue } from './use-debounced-value';
function parseFilterString(filter) {
    const terms = filter.trim().split(/\s+/).filter(Boolean);
    return terms.reduce((acc, term) => {
        if (term.startsWith('-')) {
            const excludePattern = term.slice(1).toLowerCase();
            if (excludePattern) {
                acc.excludes.push(excludePattern);
            }
        }
        else {
            acc.includes.push(term.toLowerCase());
        }
        return acc;
    }, { includes: [], excludes: [] });
}
export function useQuickFilter(fileTree) {
    const [quickFilter, setQuickFilter] = useState('');
    const debouncedFilter = useDebouncedValue(quickFilter, 150);
    const applyQuickFilter = useCallback((nodes, filter) => {
        if (!filter.trim())
            return nodes;
        const { includes, excludes } = parseFilterString(filter);
        return nodes
            .map((node) => {
            const searchableText = [node.name.toLowerCase(), node.path.toLowerCase()].join(' ');
            // Check if node matches any exclude pattern
            const isExcluded = excludes.some((exclude) => searchableText.includes(exclude));
            if (isExcluded) {
                return null;
            }
            // Check if node matches any include pattern (OR logic)
            const isIncluded = includes.length === 0 || includes.some((include) => searchableText.includes(include));
            if (node.type === 'directory' && node.children) {
                const filteredChildren = applyQuickFilter(node.children, filter);
                // Show directory if it has matching children
                if (filteredChildren.length > 0) {
                    return { ...node, children: filteredChildren };
                }
                // Or if the directory itself matches the filter
                if (isIncluded) {
                    return { ...node, children: [] };
                }
                return null;
            }
            return isIncluded ? node : null;
        })
            .filter(Boolean);
    }, []);
    const filteredTree = useMemo(() => {
        return applyQuickFilter(fileTree, debouncedFilter);
    }, [fileTree, debouncedFilter, applyQuickFilter]);
    const clearFilter = useCallback(() => {
        setQuickFilter('');
    }, []);
    return {
        quickFilter,
        setQuickFilter,
        filteredTree,
        clearFilter,
    };
}
