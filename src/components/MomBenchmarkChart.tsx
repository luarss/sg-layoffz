'use client';

import {
  Chart as ChartJS,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
} from 'chart.js';
import type { TooltipItem } from 'chart.js';
import { Bar } from 'react-chartjs-2';
import type { BenchmarkComparisonRow } from '@/lib/momBenchmark';
import {
  applyChartDefaults,
  categoryAxis,
  chartColors,
  legendOptions,
  valueAxis,
} from '@/lib/chartTheme';
import { describeBenchmark } from '@/lib/chartData';

ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend);
applyChartDefaults();

interface MomBenchmarkChartProps {
  data: BenchmarkComparisonRow[];
}

function quarterLabel(quarter: string): string {
  const [y, q] = quarter.split('-');
  return `${q} ${y.slice(2)}`;
}

export default function MomBenchmarkChart({ data }: MomBenchmarkChartProps) {
  const chartData = {
    labels: data.map((d) => quarterLabel(d.quarter)),
    datasets: [
      {
        label: 'MOM official retrenchments',
        data: data.map((d) => d.momRetrenchments),
        backgroundColor: chartColors.reference,
        borderRadius: 4,
        maxBarThickness: 18,
      },
      {
        label: 'This tracker (jobs recorded)',
        data: data.map((d) => d.trackerJobs),
        backgroundColor: chartColors.accent,
        borderRadius: 4,
        maxBarThickness: 18,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: legendOptions(),
      tooltip: {
        callbacks: {
          label: (ctx: TooltipItem<'bar'>) => {
            const d = data[ctx.dataIndex];
            if (ctx.datasetIndex === 0) {
              return `MOM: ${d.momRetrenchments.toLocaleString()} retrenchments`;
            }
            return `Tracker: ${d.trackerJobs.toLocaleString()} jobs (${d.coveragePct.toFixed(1)}% of MOM)`;
          },
        },
      },
    },
    scales: {
      x: categoryAxis(),
      y: valueAxis(),
    },
  };

  return (
    <div className="h-64">
      <Bar aria-label={describeBenchmark(data)} data={chartData} options={options} />
    </div>
  );
}
