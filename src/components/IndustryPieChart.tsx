'use client';

import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
} from 'chart.js';
import { Doughnut } from 'react-chartjs-2';

ChartJS.register(ArcElement, Tooltip, Legend);

interface IndustryPieChartProps {
  data: { industry: string; jobs: number; count: number }[];
}

const COLORS = [
  '#1a1a1a',
  '#404040',
  '#737373',
  '#a3a3a3',
  '#d4d4d4',
  '#e5e5e5',
  '#f5f5f5',
  '#262626',
  '#525252',
];

export default function IndustryPieChart({ data }: IndustryPieChartProps) {
  const chartData = {
    labels: data.map((d) => d.industry),
    datasets: [
      {
        data: data.map((d) => d.jobs),
        backgroundColor: COLORS.slice(0, data.length),
        borderColor: '#ffffff',
        borderWidth: 2,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'right' as const,
        labels: {
          font: { size: 12 },
          padding: 12,
          usePointStyle: true,
          pointStyle: 'circle',
        },
      },
      tooltip: {
        callbacks: {
          label: (ctx: any) => {
            const idx = ctx.dataIndex;
            const d = data[idx];
            return `${d.industry}: ${d.jobs.toLocaleString()} SG jobs (${d.count} ${d.count === 1 ? 'event' : 'events'})`;
          },
        },
      },
    },
  };

  return (
    <div className="h-64">
      <Doughnut data={chartData} options={options} />
    </div>
  );
}
