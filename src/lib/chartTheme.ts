import { Chart as ChartJS } from 'chart.js';
import type { Plugin } from 'chart.js';

export const chartColors = {
  ink: '#374151',
  accent: '#0369a1',
  reference: '#9ca3af',
  confirmed: '#15803d',
  rumored: '#d97706',
  rumoredFill: '#fef3c7',
  label: '#111827',
  tick: '#4b5563',
  grid: '#e5e7eb',
  surface: '#ffffff',
};

export const chartFontFamily =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const chartFontSize = 12;

export function applyChartDefaults(): void {
  ChartJS.defaults.font.family = chartFontFamily;
  ChartJS.defaults.font.size = chartFontSize;
  ChartJS.defaults.color = chartColors.tick;
}

export function categoryAxis() {
  return {
    grid: { display: false },
    border: { color: chartColors.grid },
    ticks: { color: chartColors.tick },
  };
}

export function valueAxis() {
  return {
    beginAtZero: true,
    grid: { color: chartColors.grid },
    border: { display: false },
    ticks: {
      color: chartColors.tick,
      maxTicksLimit: 6,
      callback: (value: string | number) => Number(value).toLocaleString(),
    },
  };
}

export function legendOptions() {
  return {
    display: true,
    align: 'start' as const,
    labels: { color: chartColors.tick, boxWidth: 12, boxHeight: 12 },
  };
}

export function createHatchPattern(stripeColor: string, fillColor: string): CanvasPattern | string {
  if (typeof document === 'undefined') return fillColor;
  const size = 6;
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const context = tile.getContext('2d');
  if (!context) return fillColor;
  context.fillStyle = fillColor;
  context.fillRect(0, 0, size, size);
  context.strokeStyle = stripeColor;
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(-1, 1);
  context.lineTo(1, -1);
  context.moveTo(0, size);
  context.lineTo(size, 0);
  context.moveTo(size - 1, size + 1);
  context.lineTo(size + 1, size - 1);
  context.stroke();
  return context.createPattern(tile, 'repeat') ?? fillColor;
}

export function createBarLabelPlugin(
  id: string,
  labelFor: (index: number) => string | null,
): Plugin<'bar'> {
  return {
    id,
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      const isHorizontal = chart.options.indexAxis === 'y';
      ctx.save();
      ctx.font = `600 ${chartFontSize}px ${chartFontFamily}`;
      ctx.fillStyle = chartColors.label;
      chart.getDatasetMeta(0).data.forEach((bar, index) => {
        const text = labelFor(index);
        if (!text) return;
        const { x, y } = bar.getProps(['x', 'y'], true);
        if (isHorizontal) {
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, x + 6, y);
        } else {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(text, x, Math.max(y, chartArea.top) - 6);
        }
      });
      ctx.restore();
    },
  };
}
