import type { FC } from 'react';
export interface HotspotData {
    path: string;
    score: number;
    changes: number;
    lastModified: number;
    totalLinesChanged: number;
}
interface TimelineAnalysisProps {
    hotspotData: HotspotData[];
}
declare const TimelineAnalysis: FC<TimelineAnalysisProps>;
export default TimelineAnalysis;
//# sourceMappingURL=timeline-analysis.d.ts.map