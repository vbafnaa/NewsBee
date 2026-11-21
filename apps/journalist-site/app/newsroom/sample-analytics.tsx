// Sample analytics for layout previews (Overview and Analytics). Nothing here is read from reader data;
// every place that shows it carries a "Sample data" tag. Real analytics ship in a later release.

export const SAMPLE_ANALYTICS = {
  pageViews: "31,284", uniqueReaders: "24,846", readTime: "3m 42s", videoPlays: "8,209",
  totalReadership: "24.8k", readershipChange: "+18.4% from last month", activityChange: "18.4%",
  series: [210, 250, 310, 340, 360, 345, 330, 390, 460, 520, 545, 560, 590, 640, 700, 720, 715, 760, 830, 900, 950, 1010, 1080, 1060, 1110],
  labels: ["Oct 20", "Oct 27", "Nov 3", "Nov 10", "Nov 17"],
  /** Edition view counts, newest first, for the Latest editions list. */
  editionViews: [5284, 4971, 4102, 3870, 3512],
};

export function SampleTag() {
  return <span className="jw-sample-tag" title="Sample data. Real analytics ship in a later release.">Sample data</span>;
}

/** A smooth area chart of the sample series, drawn like the mock's reader-activity chart. */
export function SampleActivityChart({ height = 200 }: { height?: number }) {
  const width = 640, max = 1200, top = 8;
  const series = SAMPLE_ANALYTICS.series;
  const step = width / (series.length - 1);
  const points = series.map((value, index) => [index * step, top + (height - top) * (1 - value / max)] as const);
  const path = points.map(([x, y], index) => {
    if (!index) return `M${x.toFixed(1)},${y.toFixed(1)}`;
    const [px, py] = points[index - 1];
    const mid = (px + x) / 2;
    return `C${mid.toFixed(1)},${py.toFixed(1)} ${mid.toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const [lastX, lastY] = points[points.length - 1];
  return <svg className="jw-sample-chart" viewBox={`-34 0 ${width + 40} ${height + 26}`} role="img" aria-label="Sample reader activity rising over 30 days">
    <defs><linearGradient id="jw-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#f4d35e" stopOpacity=".45" /><stop offset="1" stopColor="#f4d35e" stopOpacity="0" /></linearGradient></defs>
    {[0, 400, 800, 1200].map((tick) => {
      const y = top + (height - top) * (1 - tick / max);
      return <g key={tick}><line x1="0" x2={width} y1={y} y2={y} className="jw-chart-grid" />
        <text x="-8" y={y + 3} textAnchor="end" className="jw-chart-label">{tick >= 1000 ? `${tick / 1000}k` : tick}</text></g>;
    })}
    <path d={`${path} L${width},${height} L0,${height} Z`} fill="url(#jw-area)" />
    <path d={path} className="jw-chart-line" />
    <circle cx={lastX} cy={lastY} r="4" className="jw-chart-dot" />
    {SAMPLE_ANALYTICS.labels.map((label, index) => <text key={label} x={(index / (SAMPLE_ANALYTICS.labels.length - 1)) * width} y={height + 20}
      textAnchor={index === 0 ? "start" : index === SAMPLE_ANALYTICS.labels.length - 1 ? "end" : "middle"} className="jw-chart-label">{label}</text>)}
  </svg>;
}
