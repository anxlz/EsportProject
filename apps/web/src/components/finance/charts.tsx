'use client';

/**
 * Small SVG charts for the finance report, following the data-viz rules in DECISIONS.md:
 * one y-axis per chart, thin marks (≤24px columns with 4px rounded data-ends, 2px lines,
 * 8px end-dots with a 2px surface ring), hairline grid, a legend for 2+ series, a hover/focus
 * tooltip listing every series at that position, and colors from the validated --series-N
 * tokens. Text always uses text tokens, never the series color.
 *
 * Time runs left-to-right in both languages (the plot is wrapped in dir="ltr"); labels and
 * tooltips follow the page direction.
 */
import { useLocale } from 'next-intl';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';

export interface ChartSeries {
  key: string;
  label: string;
  /** CSS color, normally var(--series-N). */
  color: string;
  values: number[];
}

function niceStep(range: number, target: number) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/** Clean tick values covering [min, max] and always including zero. */
export function niceScale(minIn: number, maxIn: number, target = 4) {
  const min = Math.min(0, minIn);
  const max = Math.max(0, maxIn);
  if (min === max) return { lo: 0, hi: 1, ticks: [0, 1] };
  const step = niceStep(max - min, target);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { lo, hi, ticks };
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setWidth(Math.max(260, Math.floor(e!.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function useCompact() {
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  return (n: number) => nf.format(n);
}

export function Legend({
  items,
  shape,
}: {
  items: { label: string; color: string }[];
  shape: 'rect' | 'line';
}) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-2">
          {shape === 'rect' ? (
            <span
              aria-hidden="true"
              className="inline-block size-2.5 rounded-[2px]"
              style={{ background: i.color }}
            />
          ) : (
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-4 rounded"
              style={{ background: i.color }}
            />
          )}
          <span className="text-ink">{i.label}</span>
        </li>
      ))}
    </ul>
  );
}

function Tooltip({
  x,
  width,
  title,
  rows,
}: {
  x: number;
  width: number;
  title: string;
  rows: { label: string; value: string; color: string }[];
}) {
  const locale = useLocale();
  const w = Math.min(260, width);
  const left = Math.min(Math.max(x - w / 2, 0), width - w);
  return (
    <div
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      className="pointer-events-none absolute top-0 z-10 rounded-md border border-line bg-panel px-3 py-2 text-sm shadow-md"
      style={{ left, width: w }}
      role="status"
    >
      <p className="mb-1 text-[0.8125rem] text-muted">{title}</p>
      <ul className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-muted">
              <span
                aria-hidden="true"
                className="inline-block h-0.5 w-3 rounded"
                style={{ background: r.color }}
              />
              {r.label}
            </span>
            <span className="font-semibold whitespace-nowrap text-ink tabular-nums">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const M = { top: 12, right: 12, bottom: 28, left: 64 };

function useActiveIndex(n: number) {
  const [active, setActive] = useState<number | null>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === 'ArrowRight') setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? n) - 1));
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };
  return { active, setActive, onKeyDown };
}

function YAxis({
  ticks,
  y,
  plotW,
  fmt,
}: {
  ticks: number[];
  y: (v: number) => number;
  plotW: number;
  fmt: (n: number) => string;
}) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={M.left}
            x2={M.left + plotW}
            y1={y(t)}
            y2={y(t)}
            stroke={t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          <text
            x={M.left - 8}
            y={y(t)}
            dy="0.32em"
            textAnchor="end"
            className="fill-muted text-[11px] tabular-nums"
          >
            {fmt(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Month labels, thinned to whatever fits the width; edge labels are kept inside the chart. */
function XLabels({
  labels,
  cx,
  baseline,
  width,
}: {
  labels: string[];
  cx: (i: number) => number;
  baseline: number;
  width: number;
}) {
  const n = labels.length;
  const LABEL = 76; // px reserved per label ("Sep 2026", "سبتمبر 2026" at 11px)
  const step = n > 1 ? cx(1) - cx(0) : width;
  const every = Math.max(1, Math.ceil(LABEL / Math.max(1, step)));
  const shown = labels.map((_, i) => i % every === 0);
  const lastShown = Math.floor((n - 1) / every) * every;
  if (n > 1 && lastShown !== n - 1 && (n - 1 - lastShown) * step >= LABEL) shown[n - 1] = true;
  return (
    <g>
      {labels.map((l, i) => {
        if (!shown[i]) return null;
        const x = cx(i);
        const anchor = x < LABEL / 2 ? 'start' : x > width - LABEL / 2 ? 'end' : 'middle';
        const ax =
          anchor === 'start' ? Math.max(0, x - 10) : anchor === 'end' ? Math.min(width, x + 10) : x;
        return (
          <text
            key={i}
            x={ax}
            y={baseline + 18}
            textAnchor={anchor}
            className="fill-muted text-[11px]"
          >
            {l}
          </text>
        );
      })}
    </g>
  );
}

/** Grouped columns per period (e.g. costs vs realized revenue per month). Values ≥ 0. */
export function ColumnChart({
  labels,
  series,
  format,
  height = 220,
  label,
}: {
  labels: string[];
  series: ChartSeries[];
  format: (n: number) => string;
  height?: number;
  label: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const compact = useCompact();
  const n = labels.length;
  const { active, setActive, onKeyDown } = useActiveIndex(n);
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const { hi, ticks } = niceScale(0, max);
  const plotW = width - M.left - M.right;
  const plotH = height - M.top - M.bottom;
  const y = (v: number) => M.top + plotH - (v / hi) * plotH;
  const band = plotW / Math.max(1, n);
  const gap = 2;
  const barW = Math.max(3, Math.min(24, (band * 0.72 - gap * (series.length - 1)) / series.length));
  const groupW = barW * series.length + gap * (series.length - 1);
  const cx = (i: number) => M.left + band * i + band / 2;
  const baseline = y(0);

  const bar = (x: number, v: number) => {
    const top = y(v);
    const h = baseline - top;
    if (h <= 0) return '';
    const r = Math.min(4, h, barW / 2);
    return `M${x},${baseline}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${baseline}Z`;
  };

  return (
    <div ref={ref} dir="ltr" className="relative w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        className="block overflow-visible focus-visible:outline-2"
      >
        <YAxis ticks={ticks} y={y} plotW={plotW} fmt={compact} />
        {labels.map((_, i) => {
          const x0 = cx(i) - groupW / 2;
          return (
            <g key={i} opacity={active === null || active === i ? 1 : 0.55}>
              {series.map((s, si) => (
                <path
                  key={s.key}
                  d={bar(x0 + si * (barW + gap), s.values[i] ?? 0)}
                  fill={s.color}
                />
              ))}
              <rect
                x={M.left + band * i}
                y={M.top}
                width={band}
                height={plotH}
                fill="transparent"
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
              />
            </g>
          );
        })}
        <XLabels labels={labels} cx={cx} baseline={baseline} width={width} />
      </svg>
      {active !== null && (
        <Tooltip
          x={cx(active)}
          width={width}
          title={labels[active]!}
          rows={series.map((s) => ({
            label: s.label,
            value: format(s.values[active] ?? 0),
            color: s.color,
          }))}
        />
      )}
    </div>
  );
}

/** Lines over periods against a zero baseline (cumulative result, scenario positions). */
export function LineChart({
  labels,
  series,
  format,
  height = 220,
  label,
  marker,
  endLabels = true,
}: {
  labels: string[];
  series: ChartSeries[];
  format: (n: number) => string;
  height?: number;
  label: string;
  /** Optional vertical marker (e.g. break-even month) with its caption. */
  marker?: { index: number; caption: string } | null;
  endLabels?: boolean;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const compact = useCompact();
  const clip = useId();
  const n = labels.length;
  const { active, setActive, onKeyDown } = useActiveIndex(n);
  const all = series.flatMap((s) => s.values);
  const { lo, hi, ticks } = niceScale(Math.min(0, ...all), Math.max(0, ...all));
  const labelRoom = endLabels && series.length > 1 ? 92 : 0;
  const plotW = width - M.left - M.right - labelRoom;
  const plotH = height - M.top - M.bottom;
  // Inset the first and last points so their labels and end-dots stay clear of the axis.
  const inset = 16;
  const x = (i: number) =>
    M.left + inset + (n <= 1 ? (plotW - 2 * inset) / 2 : (i / (n - 1)) * (plotW - 2 * inset));
  const y = (v: number) => M.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');

  // Direct end labels only when they don't collide; otherwise the legend carries identity.
  const ends = series.map((s) => y(s.values[n - 1] ?? 0)).sort((a, b) => a - b);
  const collide = ends.some((v, i) => i > 0 && v - ends[i - 1]! < 14);
  const showEnds = endLabels && series.length > 1 && !collide && n > 0;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = n <= 1 ? 0 : Math.round(((px - M.left - inset) / (plotW - 2 * inset)) * (n - 1));
    setActive(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div ref={ref} dir="ltr" className="relative w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        className="block overflow-visible focus-visible:outline-2"
      >
        <clipPath id={clip}>
          <rect x={M.left - 6} y={0} width={plotW + 12} height={height} />
        </clipPath>
        <YAxis ticks={ticks} y={y} plotW={plotW} fmt={compact} />
        {marker && marker.index >= 0 && marker.index < n && (
          <g>
            <line
              x1={x(marker.index)}
              x2={x(marker.index)}
              y1={M.top}
              y2={M.top + plotH}
              stroke="var(--chart-axis)"
              strokeWidth={1}
            />
            <text x={x(marker.index) + 4} y={M.top + 10} className="fill-muted text-[11px]">
              {marker.caption}
            </text>
          </g>
        )}
        <g clipPath={`url(#${clip})`}>
          {series.map((s) => (
            <path
              key={s.key}
              d={path(s.values)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {n > 0 &&
            series.map((s) => (
              <circle
                key={s.key}
                cx={x(n - 1)}
                cy={y(s.values[n - 1] ?? 0)}
                r={4}
                fill={s.color}
                stroke="var(--panel)"
                strokeWidth={2}
              />
            ))}
        </g>
        {showEnds &&
          series.map((s) => (
            <text
              key={s.key}
              x={x(n - 1) + 10}
              y={y(s.values[n - 1] ?? 0)}
              dy="0.32em"
              className="fill-ink text-[11px]"
            >
              {s.label}
            </text>
          ))}
        {active !== null && (
          <g pointerEvents="none">
            <line
              x1={x(active)}
              x2={x(active)}
              y1={M.top}
              y2={M.top + plotH}
              stroke="var(--chart-axis)"
              strokeWidth={1}
            />
            {series.map((s) => (
              <circle
                key={s.key}
                cx={x(active)}
                cy={y(s.values[active] ?? 0)}
                r={4}
                fill={s.color}
                stroke="var(--panel)"
                strokeWidth={2}
              />
            ))}
          </g>
        )}
        <XLabels labels={labels} cx={x} baseline={M.top + plotH} width={width} />
        <rect
          x={M.left}
          y={M.top}
          width={Math.max(0, plotW)}
          height={plotH}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setActive(null)}
        />
      </svg>
      {active !== null && (
        <Tooltip
          x={x(active)}
          width={width}
          title={labels[active]!}
          rows={series.map((s) => ({
            label: s.label,
            value: format(s.values[active] ?? 0),
            color: s.color,
          }))}
        />
      )}
    </div>
  );
}

/** A single ratio against a plan: the fill carries state; text + icon say it too. */
export function Meter({
  percent,
  label,
  children,
}: {
  percent: number;
  label: string;
  children?: ReactNode;
}) {
  const tone = percent > 100 ? 'var(--brick)' : percent >= 90 ? 'var(--amber)' : 'var(--turf)';
  return (
    <div className="flex flex-col gap-1">
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-panel-2 ring-1 ring-line ring-inset"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(percent, 100))}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%`, background: tone }}
        />
      </div>
      {children}
    </div>
  );
}
