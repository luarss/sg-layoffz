'use client';

import {
  Chart as ChartJS,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
} from 'chart.js';
import type { TooltipItem } from 'chart.js';
import { Bar } from 'react-chartjs-2';
import {
  applyChartDefaults,
  categoryAxis,
  chartColors,
  createBarLabelPlugin,
  valueAxis,
} from '@/lib/chartTheme';
import { describeIndustries, pluralize, sortIndustriesByJobs } from '@/lib/chartData';
import ChartDataTable from './ChartDataTable';

ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip);
applyChartDefaults();

interface IndustryBarChartProps {
  data: { industry: string; jobs: number; count: number }[];
}

const ROW_HEIGHT = 32;
const AXIS_HEIGHT = 32;

export default function IndustryBarChart({ data }: IndustryBarChartProps) {
  const rows = sortIndustriesByJobs(data);

  const chartData = {
    labels: rows.map((d) => d.industry),
    datasets: [
      {
        label: 'SG jobs cut',
        data: rows.map((d) => d.jobs),
        backgroundColor: chartColors.ink,
        borderRadius: 4,
        borderSkipped: 'start' as const,
        maxBarThickness: 18,
      },
    ],
  };

  const options = {
    indexAxis: 'y' as const,
    responsive: true,
    maintainAspectRatio: false,
    layout: { padding: { right: 56 } },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: TooltipItem<'bar'>) => {
            const row = rows[ctx.dataIndex];
            return `${row.jobs.toLocaleString()} SG jobs (${pluralize(row.count, 'event')})`;
          },
        },
      },
    },
    scales: {
      x: { ...valueAxis(), ticks: { ...valueAxis().ticks, maxTicksLimit: 5 } },
      y: { ...categoryAxis(), ticks: { color: chartColors.label } },
    },
  };

  const plugins = [createBarLabelPlugin('industryValue', (index) => rows[index].jobs.toLocaleString())];

  return (
    <div>
      <div style={{ height: rows.length * ROW_HEIGHT + AXIS_HEIGHT }}>
        <Bar
          aria-label={describeIndustries(rows)}
          data={chartData}
          options={options}
          plugins={plugins}
        />
      </div>
      <ChartDataTable
        caption="SG jobs cut by industry"
        columns={['Industry', 'SG jobs cut', 'Confirmed events']}
        rows={rows.map((d) => [d.industry, d.jobs, d.count])}
      />
    </div>
  );
}
