import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LineChart, ScatterChart } from "echarts/charts";
import { GridComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { usePrefersReducedMotion } from "../shared/motion";
import { axisDomain, placeFlagged, type Threshold, type TelemetrySeries } from "./insightApi";

echarts.use([LineChart, ScatterChart, GridComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

type Tokens = ReturnType<typeof readChartTokens>;

function readChartTokens(element: Element) {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    text: token("--text", "#231815"),
    text2: token("--text-2", "#6B5F52"),
    line: token("--line", "#E6D6BE"),
    surface: token("--surface", "#FFFBF3"),
    accent: token("--accent", "#8E1B2E"),
    warn: token("--warn", "#A35B33"),
    danger: token("--danger", "#B02239"),
    mono: token("--font-mono", "monospace"),
    sans: token("--font-sans", "sans-serif")
  };
}

/** Re-reads the tokens whenever an ancestor's data-theme flips (admin light/dark switch). */
function useThemeVersion(element: HTMLElement | null) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const themed = element?.closest("[data-theme]");
    if (!themed || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setVersion((value) => value + 1));
    observer.observe(themed, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [element]);
  return version;
}

/** Canvas cannot parse color-mix(), so tokens (hex) become rgba. */
export function alpha(color: string, amount: number) {
  const hex = color.trim().replace("#", "");
  const full = hex.length === 3 ? [...hex].map((char) => char + char).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return color;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${amount})`;
}

type Props = { series: TelemetrySeries; threshold?: Threshold; unit: string; digits: number; bucketMs: number; label: string };

export function TelemetryChart({ series, threshold, unit, digits, bucketMs, label }: Props) {
  const { t, i18n } = useTranslation();
  const reduced = usePrefersReducedMotion();
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const themeVersion = useThemeVersion(element);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    setElement(node);
    const instance = echarts.init(node, undefined, { renderer: "canvas" });
    chart.current = instance;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => instance.resize());
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = chart.current;
    if (!instance || !host.current) return;
    const tokens: Tokens = readChartTokens(host.current);
    const domain = axisDomain(series, threshold);
    const fmt = (value: number | null) => (value === null ? "—" : `${value.toFixed(digits)}${unit ? ` ${unit}` : ""}`);
    const time = (value: number | string) => new Date(value).toLocaleString(i18n.language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const axis = {
      axisLine: { lineStyle: { color: tokens.line } },
      axisTick: { lineStyle: { color: tokens.line } },
      axisLabel: { color: tokens.text2, fontFamily: tokens.mono, fontSize: 11 },
      splitLine: { lineStyle: { color: tokens.line, type: "dashed" as const, opacity: 0.7 } }
    };
    const points = series.buckets.map((bucket) => new Date(bucket.ts).getTime() + bucketMs / 2);
    const flagged = (quality: "dirty" | "suspect") => series.flagged
      .filter((sample) => sample.quality === quality || (quality === "dirty" && !Number.isFinite(sample.value)))
      .map((sample) => {
        const place = placeFlagged(sample, domain);
        return { value: [new Date(sample.ts).getTime(), place.y], sample, off: place.off };
      });
    const thresholdLines = [
      threshold?.max !== undefined ? { yAxis: threshold.max, name: `${t("admin.telemetry.thresholdMax")} ${fmt(threshold.max)}` } : null,
      threshold?.min !== undefined ? { yAxis: threshold.min, name: `${t("admin.telemetry.thresholdMin")} ${fmt(threshold.min)}` } : null
    ].filter(Boolean);
    const names = { band: t("admin.telemetry.band"), avg: t("admin.telemetry.avg"), dirty: t("admin.telemetry.quality.dirty"), suspect: t("admin.telemetry.quality.suspect") };

    instance.setOption({
      animation: !reduced,
      animationDurationUpdate: reduced ? 0 : 400,
      textStyle: { color: tokens.text, fontFamily: tokens.sans },
      grid: { left: 52, right: 96, top: 28, bottom: 30 },
      tooltip: {
        trigger: "axis",
        backgroundColor: tokens.surface,
        borderColor: tokens.line,
        textStyle: { color: tokens.text, fontSize: 12 },
        axisPointer: { type: "line", lineStyle: { color: tokens.text2, type: "dashed" } },
        formatter: (raw: unknown) => {
          const params = (Array.isArray(raw) ? raw : [raw]) as Array<{ axisValue: number }>;
          const at = Number(params[0]?.axisValue);
          const index = Math.min(series.buckets.length - 1, Math.max(0, Math.floor((at - new Date(series.buckets[0]!.ts).getTime()) / bucketMs)));
          const bucket = series.buckets[index]!;
          const start = new Date(bucket.ts).getTime();
          const inBucket = series.flagged.filter((sample) => { const ts = new Date(sample.ts).getTime(); return ts >= start && ts < start + bucketMs; });
          const row = (name: string, value: string) => `<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:${tokens.text2}">${name}</span><b style="font-family:${tokens.mono}">${value}</b></div>`;
          return [
            `<div style="font-family:${tokens.mono};margin-bottom:4px">${time(start)} – ${time(start + bucketMs)}</div>`,
            row(names.avg, fmt(bucket.avg)),
            row(t("admin.telemetry.min"), fmt(bucket.min)),
            row(t("admin.telemetry.max"), fmt(bucket.max)),
            row(t("admin.telemetry.samples"), String(bucket.count)),
            ...inBucket.slice(0, 3).map((sample) => row(
              `○ ${t(`admin.telemetry.quality.${sample.quality}`)}`,
              `${Number.isFinite(sample.value) ? sample.value.toFixed(digits) : String(sample.value)}${placeFlagged(sample, domain).off ? ` (${t("admin.telemetry.offScale")})` : ""}`
            )),
            inBucket.length > 3 ? `<div style="color:${tokens.text2}">+${inBucket.length - 3}</div>` : ""
          ].join("");
        }
      },
      xAxis: { type: "time", ...axis, splitLine: { show: false }, axisLabel: { ...axis.axisLabel, hideOverlap: true } },
      yAxis: { type: "value", min: domain.min, max: domain.max, ...axis, axisLabel: { ...axis.axisLabel, formatter: (value: number) => Number(value.toFixed(digits)).toString() }, name: unit, nameTextStyle: { color: tokens.text2, fontFamily: tokens.mono, align: "right" } },
      series: [
        // Band = transparent "min" + stacked (max − min) filled area.
        // Thresholds hang on this series so hiding "average" in the legend keeps them.
        {
          name: "__band_base",
          type: "line",
          stack: "band",
          symbol: "none",
          silent: true,
          lineStyle: { opacity: 0 },
          data: series.buckets.map((bucket, index) => [points[index], bucket.min]),
          markLine: thresholdLines.length ? {
            silent: true,
            symbol: "none",
            lineStyle: { color: tokens.warn, type: [6, 4], width: 1.5 },
            label: { position: "end", color: tokens.text, fontFamily: tokens.mono, fontSize: 11, formatter: (item: { name: string }) => item.name },
            data: thresholdLines
          } : undefined
        },
        {
          name: names.band,
          type: "line",
          stack: "band",
          symbol: "none",
          silent: true,
          lineStyle: { opacity: 0 },
          itemStyle: { color: alpha(tokens.accent, 0.35) },
          areaStyle: { color: alpha(tokens.accent, 0.16) },
          data: series.buckets.map((bucket, index) => [points[index], bucket.min === null || bucket.max === null ? null : bucket.max - bucket.min])
        },
        {
          name: names.avg,
          type: "line",
          symbol: "circle",
          showSymbol: false,
          symbolSize: 8,
          lineStyle: { width: 2, color: tokens.accent },
          itemStyle: { color: tokens.accent, borderColor: tokens.surface, borderWidth: 2 },
          data: series.buckets.map((bucket, index) => [points[index], bucket.avg === null ? null : Number(bucket.avg.toFixed(4))])
        },
        ...(["dirty", "suspect"] as const).map((quality) => ({
          name: names[quality],
          type: "scatter",
          symbol: "circle",
          symbolSize: 10,
          clip: false,
          z: 5,
          itemStyle: { color: tokens.surface, borderColor: quality === "dirty" ? tokens.danger : tokens.warn, borderWidth: 2 },
          emphasis: { scale: 1.4 },
          data: flagged(quality)
        }))
      ]
    }, { notMerge: true });
  }, [series, threshold, unit, digits, bucketMs, reduced, t, i18n.language, themeVersion]);

  return <div ref={host} className="admin-telemetry-chart" role="img" aria-label={label} />;
}
