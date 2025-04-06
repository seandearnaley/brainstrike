import { useMemo } from 'react';
import type { FC } from 'react';

// Define the type for hotspot data as used in the store
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

// Helper function to group hotspot data by date (YYYY-MM-DD) and sum scores
const groupDataByDate = (data: HotspotData[]) => {
  return data.reduce((acc: Record<string, number>, item) => {
    const date = new Date(item.lastModified * 1000).toISOString().substring(0, 10);
    if (!acc[date]) {
      acc[date] = 0;
    }
    acc[date] += item.score;
    return acc;
  }, {});
};

const TimelineAnalysis: FC<TimelineAnalysisProps> = ({ hotspotData }) => {
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

  return (
    <div className="p-4">
      <h3 className="text-lg font-semibold mb-2">Hotspot Timeline</h3>
      <div className="space-y-2">
        {dataArray.map(({ date, score }) => {
          // Compute width percentage relative to maxScore
          const widthPercent = (score / maxScore) * 100;
          return (
            <div key={date} className="flex items-center">
              <div className="w-24 text-sm">{date}</div>
              <div className="flex-1 bg-gray-200 h-4 relative">
                <div className="bg-blue-500 h-4" style={{ width: `${widthPercent}%` }} />
              </div>
              <div className="w-16 text-sm text-right ml-2">{score.toFixed(1)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TimelineAnalysis;
