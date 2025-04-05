import { jsx as _jsx } from "react/jsx-runtime";
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TimelineAnalysis from '../timeline-analysis';
// Helper function to create timestamp for a given date string (YYYY-MM-DD)
const createTimestamp = (dateString) => {
    return new Date(dateString).getTime() / 1000;
};
describe('TimelineAnalysis', () => {
    it('renders the timeline header correctly', () => {
        const sampleData = [
            {
                path: 'path/to/file1.ts',
                score: 10,
                changes: 5,
                lastModified: createTimestamp('2023-05-01'),
                totalLinesChanged: 20,
            },
        ];
        render(_jsx(TimelineAnalysis, { hotspotData: sampleData }));
        expect(screen.getByText('Hotspot Timeline')).toBeInTheDocument();
    });
    it('displays dates and scores correctly', () => {
        const sampleData = [
            {
                path: 'path/to/file1.ts',
                score: 10.5,
                changes: 5,
                lastModified: createTimestamp('2023-05-01'),
                totalLinesChanged: 20,
            },
            {
                path: 'path/to/file2.ts',
                score: 5.75,
                changes: 3,
                lastModified: createTimestamp('2023-05-02'),
                totalLinesChanged: 15,
            },
        ];
        render(_jsx(TimelineAnalysis, { hotspotData: sampleData }));
        expect(screen.getByText('2023-05-01')).toBeInTheDocument();
        expect(screen.getByText('2023-05-02')).toBeInTheDocument();
        expect(screen.getByText('10.5')).toBeInTheDocument();
        expect(screen.getByText('5.8')).toBeInTheDocument(); // Rounded to 1 decimal place
    });
    it('groups data by date correctly', () => {
        const sameDate = createTimestamp('2023-05-01');
        const sampleData = [
            {
                path: 'path/to/file1.ts',
                score: 10,
                changes: 5,
                lastModified: sameDate,
                totalLinesChanged: 20,
            },
            {
                path: 'path/to/file2.ts',
                score: 5,
                changes: 3,
                lastModified: sameDate,
                totalLinesChanged: 15,
            },
        ];
        render(_jsx(TimelineAnalysis, { hotspotData: sampleData }));
        // Only one date should be displayed
        const dateElements = screen.getAllByText('2023-05-01');
        expect(dateElements.length).toBe(1);
        // The scores should be summed
        expect(screen.getByText('15.0')).toBeInTheDocument();
    });
    it('correctly displays the timeline with correct scaling', () => {
        const sampleData = [
            {
                path: 'path/to/file1.ts',
                score: 10,
                changes: 5,
                lastModified: createTimestamp('2023-05-01'),
                totalLinesChanged: 20,
            },
            {
                path: 'path/to/file2.ts',
                score: 5,
                changes: 3,
                lastModified: createTimestamp('2023-05-02'),
                totalLinesChanged: 15,
            },
        ];
        render(_jsx(TimelineAnalysis, { hotspotData: sampleData }));
        // Get the div elements representing the bars
        const bars = document.querySelectorAll('.bg-blue-500');
        expect(bars.length).toBe(2);
        // First bar (score 10) should be at 100% width
        expect(bars[0]).toHaveStyle('width: 100%');
        // Second bar (score 5) should be at 50% width
        expect(bars[1]).toHaveStyle('width: 50%');
    });
    it('handles empty data gracefully', () => {
        render(_jsx(TimelineAnalysis, { hotspotData: [] }));
        // The component header should still be rendered
        expect(screen.getByText('Hotspot Timeline')).toBeInTheDocument();
        // There should be no date or score elements
        expect(document.querySelectorAll('.bg-blue-500').length).toBe(0);
    });
});
