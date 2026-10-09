import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { usePrefersReducedMotion } from "../../shared/motion";
import { echartsTheme, readTokens, type HourlyBuckets } from "./wallboardData";

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

const THEME = "ul-wallboard";
const HOURS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}`);

/** Today's borrows (bars) and returns (line) per hour; the theme is built from the CSS tokens. */
export function HourlyChart({ buckets }: { buckets: HourlyBuckets }) {
  const { t, i18n } = useTranslation();
  const reduced = usePrefersReducedMotion();
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const tokens = readTokens(element);
    echarts.registerTheme(THEME, echartsTheme(tokens));
    const instance = echarts.init(element, THEME, { renderer: "canvas" });
    chart.current = instance;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => instance.resize());
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = chart.current;
    if (!instance || !host.current) return;
    const tokens = readTokens(host.current);
    const hour = new Date().getHours();
    instance.setOption({
      animation: !reduced,
      animationDurationUpdate: reduced ? 0 : 600,
      grid: { left: 36, right: 12, top: 30, bottom: 26 },
      legend: { top: 0, right: 0, itemWidth: 12, itemHeight: 8, data: [t("admin.wallboard.borrowed"), t("admin.wallboard.returned")] },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: HOURS, axisLabel: { interval: 2 } },
      yAxis: { type: "value", minInterval: 1 },
      series: [
        {
          name: t("admin.wallboard.borrowed"),
          type: "bar",
          barWidth: "56%",
          data: buckets.borrowed.map((value, index) => ({ value, itemStyle: { color: index === hour ? tokens.blush : tokens.accent, borderRadius: [3, 3, 0, 0] } })),
          markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: tokens.blush, type: "dashed" }, data: [{ xAxis: HOURS[hour] }] }
        },
        { name: t("admin.wallboard.returned"), type: "line", smooth: true, symbol: "none", lineStyle: { width: 2, color: tokens.success }, data: buckets.returned }
      ]
    });
  }, [buckets, reduced, t, i18n.language]);

  return <div ref={host} className="wb-chart" role="img" aria-label={t("admin.wallboard.chartLabel", { borrowed: buckets.borrowed.reduce((sum, value) => sum + value, 0), returned: buckets.returned.reduce((sum, value) => sum + value, 0) })} />;
}
