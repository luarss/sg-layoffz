'use client';

import { useMemo, useState } from 'react';
import {
  Chart as ChartJS,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
} from 'chart.js';
import type { Plugin, TooltipItem } from 'chart.js';
import { Bar } from 'react-chartjs-2';
import {
  applyChartDefaults,
  categoryAxis,
  chartColors,
  createBarLabelPlugin,
  createHatchPattern,
  legendOptions,
  valueAxis,
} from '@/lib/chartTheme';
import {
  describeMonthlyEvents,
  describeMonthlyJobs,
  findAxisCap,
  formatMonthLabel,
  pluralize,
} from '@/lib/chartData';
import ChartDataTable from './ChartDataTable';

ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend);
applyChartDefaults();

type MonthlyRow = { month: string; jobs: number; count: number; rumoredCount: number };

interface MonthlyBarChartProps {
  data: MonthlyRow[];
  metric?: 'jobs' | 'companies';
}

export default function MonthlyBarChart({ data, metric = 'jobs' }: MonthlyBarChartProps) {
  return metric === 'companies' ? <MonthlyEventsChart data={data} /> : <MonthlyJobsChart data={data} />;
}

function createAxisBreakPlugin(isClipped: (index: number) => boolean): Plugin<'bar'> {
  return {
    id: 'axisBreak',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.strokeStyle = chartColors.surface;
      ctx.lineWidth = 3;
      chart.getDatasetMeta(0).data.forEach((bar, index) => {
        if (!isClipped(index)) return;
        const { x, width } = bar.getProps(['x', 'width'], true);
        const halfWidth = width / 2 + 2;
        [10, 16].forEach((offset) => {
          const y = chartArea.top + offset;
          ctx.beginPath();
          ctx.moveTo(x - halfWidth, y + 3);
          ctx.lineTo(x + halfWidth, y - 3);
          ctx.stroke();
        });
      });
      ctx.restore();
    },
  };
}

function MonthlyJobsChart({ data }: { data: MonthlyRow[] }) {
  const axisCap = useMemo(() => findAxisCap(data.map((d) => d.jobs)), [data]);
  const [showFullScale, setShowFullScale] = useState(false);
  const activeCap = showFullScale ? null : axisCap;
  const isClipped = (index: number) => activeCap !== null && data[index].jobs > activeCap;
  const clippedRows = activeCap === null ? [] : data.filter((d) => d.jobs > activeCap);

  const chartData = {
    labels: data.map((d) => formatMonthLabel(d.month)),
    datasets: [
      {
        label: 'SG jobs cut',
        data: data.map((d) => d.jobs),
        backgroundColor: chartColors.ink,
        borderRadius: 4,
        maxBarThickness: 20,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    layout: { padding: { top: activeCap === null ? 0 : 20 } },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: TooltipItem<'bar'>) => {
            const row = data[ctx.dataIndex];
            return `${row.jobs.toLocaleString()} SG jobs (${pluralize(row.count, 'event')})`;
          },
        },
      },
    },
    scales: {
      x: categoryAxis(),
      y: { ...valueAxis(), ...(activeCap === null ? {} : { max: activeCap }) },
    },
  };

  const plugins = [
    createAxisBreakPlugin(isClipped),
    createBarLabelPlugin('clippedValue', (index) =>
      isClipped(index) ? data[index].jobs.toLocaleString() : null,
    ),
  ];

  return (
    <div>
      <div className="h-64">
        <Bar
          aria-label={describeMonthlyJobs(data)}
          key={activeCap ?? 'full'}
          data={chartData}
          options={options}
          plugins={plugins}
        />
      </div>
      {axisCap !== null && (
        <p className="mt-3 text-xs text-gray-600">
          {clippedRows.length > 0
            ? `${clippedRows
                .map((d) => `${formatMonthLabel(d.month)} (${d.jobs.toLocaleString()} jobs)`)
                .join(', ')} runs past the top of the axis, which is cut at ${axisCap.toLocaleString()} so other months stay readable. `
            : 'Showing the full scale. '}
          <button
            type="button"
            onClick={() => setShowFullScale((current) => !current)}
            className="text-sky-700 underline underline-offset-2 hover:text-sky-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700"
          >
            {showFullScale ? `Cut axis at ${axisCap.toLocaleString()}` : 'Show full scale'}
          </button>
        </p>
      )}
      <ChartDataTable
        caption="SG jobs cut by month"
        columns={['Month', 'SG jobs cut', 'Confirmed events']}
        rows={data.map((d) => [formatMonthLabel(d.month), d.jobs, d.count])}
      />
    </div>
  );
}

function MonthlyEventsChart({ data }: { data: MonthlyRow[] }) {
  const rumoredPattern = useMemo(
    () => createHatchPattern(chartColors.rumored, chartColors.rumoredFill),
    [],
  );

  const chartData = {
    labels: data.map((d) => formatMonthLabel(d.month)),
    datasets: [
      {
        label: 'Confirmed',
        data: data.map((d) => d.count),
        backgroundColor: chartColors.confirmed,
        borderColor: chartColors.surface,
        borderWidth: { top: 2 },
        borderSkipped: 'bottom' as const,
        maxBarThickness: 20,
        stack: 'events',
      },
      {
        label: 'Rumored (hatched)',
        data: data.map((d) => d.rumoredCount),
        backgroundColor: rumoredPattern,
        borderColor: chartColors.rumored,
        borderWidth: 1,
        borderRadius: { topLeft: 4, topRight: 4 },
        borderSkipped: 'bottom' as const,
        maxBarThickness: 20,
        stack: 'events',
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
            const status = ctx.datasetIndex === 0 ? 'Confirmed' : 'Rumored (unverified)';
            return `${status}: ${pluralize(ctx.parsed.y ?? 0, 'event')}`;
          },
        },
      },
    },
    scales: {
      x: { ...categoryAxis(), stacked: true },
      y: { ...valueAxis(), stacked: true, ticks: { ...valueAxis().ticks, precision: 0 } },
    },
  };

  return (
    <div>
      <div className="h-64">
        <Bar aria-label={describeMonthlyEvents(data)} data={chartData} options={options} />
      </div>
      <ChartDataTable
        caption="Layoff events by month and status"
        columns={['Month', 'Confirmed events', 'Rumored events']}
        rows={data.map((d) => [formatMonthLabel(d.month), d.count, d.rumoredCount])}
      />
    </div>
  );
}
