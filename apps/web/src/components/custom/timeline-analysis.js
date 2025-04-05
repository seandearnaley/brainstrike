import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from 'react';
// Helper function to group hotspot data by date (YYYY-MM-DD) and sum scores
const groupDataByDate = (data) => {
    return data.reduce((acc, item) => {
        const date = new Date(item.lastModified * 1000).toISOString().substring(0, 10);
        if (!acc[date]) {
            acc[date] = 0;
        }
        acc[date] += item.score;
        return acc;
    }, {});
};
const TimelineAnalysis = ({ hotspotData }) => {
    const groupedData = useMemo(() => groupDataByDate(hotspotData), [hotspotData]);
    // Convert groupedData to an array of { date, score } and sort by date
    const dataArray = useMemo(() => {
        return Object.entries(groupedData)
            .map(([date, score]) => ({ date, score }))
            .sort((a, b) => a.date.localeCompare(b.date));
    }, [groupedData]);
    // Determine maximum score for scaling
    const maxScore = useMemo(() => {
        return Math.max(...dataArray.map((item) => item.score), 1);
    }, [dataArray]);
    return (_jsxs("div", { className: "p-4", children: [_jsx("h3", { className: "text-lg font-semibold mb-2", children: "Hotspot Timeline" }), _jsx("div", { className: "space-y-2", children: dataArray.map(({ date, score }) => {
                    // Compute width percentage relative to maxScore
                    const widthPercent = (score / maxScore) * 100;
                    return (_jsxs("div", { className: "flex items-center", children: [_jsx("div", { className: "w-24 text-sm", children: date }), _jsx("div", { className: "flex-1 bg-gray-200 h-4 relative", children: _jsx("div", { className: "bg-blue-500 h-4", style: { width: `${widthPercent}%` } }) }), _jsx("div", { className: "w-16 text-sm text-right ml-2", children: score.toFixed(1) })] }, date));
                }) })] }));
};
export default TimelineAnalysis;
