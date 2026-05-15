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

ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend);

interface MonthlyBarChartProps {
  data: { month: string; jobs: number; count: number }[];
}

export default function MonthlyBarChart({ data }: MonthlyBarChartProps) {
  const chartData = {
    labels: data.map((d) => {
      const [y, m] = d.month.split('-');
      return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m)-1]} ${y.slice(2)}`;
    }),
    datasets: [
      {
        label: 'Jobs Cut',
        data: data.map((d) => d.jobs),
        backgroundColor: '#1a1a1a',
        borderRadius: 4,
        barThickness: 20,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: any) => {
            const idx = ctx.dataIndex;
            const d = data[idx];
            return `${d.jobs.toLocaleString()} jobs (${d.count} ${d.count === 1 ? 'company' : 'companies'})`;
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
