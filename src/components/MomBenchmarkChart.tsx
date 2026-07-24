'use client';

import {
  Chart as ChartJS,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import type { BenchmarkComparisonRow } from '@/lib/momBenchmark';

ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend);

interface MomBenchmarkChartProps {
  data: BenchmarkComparisonRow[];
}

function quarterLabel(quarter: string): string {
  const [y, q] = quarter.split('-');
  return `${q} ${y.slice(2)}`;
}

export default function MomBenchmarkChart({ data }: MomBenchmarkChartProps) {
  const labels = data.map((d) => quarterLabel(d.quarter));

  const chartData = {
    labels,
    datasets: [
      {
        label: 'MOM official retrenchments',
        data: data.map((d) => d.momRetrenchments),
        backgroundColor: '#9ca3af',
        borderRadius: 4,
        barThickness: 18,
      },
      {
        label: 'This tracker (jobs recorded)',
        data: data.map((d) => d.trackerJobs),
        backgroundColor: '#1a1a1a',
        borderRadius: 4,
        barThickness: 18,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        labels: { font: { size: 12 }, color: '#6b7280', boxWidth: 12 },
      },
      tooltip: {
        callbacks: {
          label: (ctx: any) => {
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
      x: {
        grid: { display: false },
        ticks: { font: { size: 12 }, color: '#9ca3af' },
      },
      y: {
        beginAtZero: true,
        grid: { color: '#f3f4f6' },
        ticks: { font: { size: 12 }, color: '#9ca3af' },
      },
    },
  };

  return (
    <div className="h-64">
      <Bar data={chartData} options={options} />
    </div>
  );
}
