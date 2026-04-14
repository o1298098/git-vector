import {
  CHART_LEFT_PADDING,
  CHART_RIGHT_PADDING,
  CHART_VIEW_WIDTH,
  type DailyUsageRow,
  type Point,
} from "./types";

export function numberText(value: number | undefined): string {
  return Number(value || 0).toLocaleString();
}

export function shortDayLabel(day: string): string {
  const date = day.includes("T") ? new Date(day) : new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return day;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function shortHourLabel(hour: string): string {
  const date = new Date(hour);
  if (Number.isNaN(date.getTime())) return hour;
  return `${String(date.getHours()).padStart(2, "0")}:00`;
}

export function compactNum(value: number | undefined): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function smoothPath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const current = points[i];
    const controlX = (prev.x + current.x) / 2;
    path += ` C ${controlX} ${prev.y}, ${controlX} ${current.y}, ${current.x} ${current.y}`;
  }
  return path;
}

export function computeTrendChart(trendRows: DailyUsageRow[], trendMax: number) {
  if (trendRows.length === 0) {
    const width = CHART_VIEW_WIDTH;
    const height = 240;
    const left = CHART_LEFT_PADDING;
    const rightPadding = CHART_RIGHT_PADDING;
    const top = 12;
    const bottom = 36;
    const baselineY = height - bottom;
    return {
      promptLine: "",
      completionLine: "",
      promptArea: "",
      completionArea: "",
      promptLast: null as Point | null,
      completionLast: null as Point | null,
      left,
      right: width - rightPadding,
      mid: (left + (width - rightPadding)) / 2,
      top,
      axisBottom: baselineY,
      yTicks: [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
        y: baselineY - (height - top - bottom) * ratio,
        value: 0,
      })),
    };
  }
  const width = CHART_VIEW_WIDTH;
  const height = 240;
  const left = CHART_LEFT_PADDING;
  const rightPadding = CHART_RIGHT_PADDING;
  const top = 12;
  const bottom = 36;
  const innerWidth = width - left - rightPadding;
  const innerHeight = height - top - bottom;
  const isSinglePoint = trendRows.length === 1;
  const len = Math.max(1, trendRows.length - 1);
  const promptPoints: Point[] = [];
  const completionPoints: Point[] = [];
  if (isSinglePoint) {
    const row = trendRows[0];
    const prompt = Number(row.prompt_tokens || 0);
    const completion = Number(row.completion_tokens || 0);
    const promptY = top + innerHeight - (innerHeight * prompt) / trendMax;
    const completionY = top + innerHeight - (innerHeight * completion) / trendMax;
    promptPoints.push({ x: left, y: promptY }, { x: width - rightPadding, y: promptY });
    completionPoints.push({ x: left, y: completionY }, { x: width - rightPadding, y: completionY });
  } else {
    trendRows.forEach((row, index) => {
      const x = left + (innerWidth * index) / len;
      const prompt = Number(row.prompt_tokens || 0);
      const completion = Number(row.completion_tokens || 0);
      const promptY = top + innerHeight - (innerHeight * prompt) / trendMax;
      const completionY = top + innerHeight - (innerHeight * completion) / trendMax;
      promptPoints.push({ x, y: promptY });
      completionPoints.push({ x, y: completionY });
    });
  }
  const promptLine = smoothPath(promptPoints);
  const completionLine = smoothPath(completionPoints);
  const baselineY = top + innerHeight;
  const promptArea =
    promptPoints.length > 0
      ? `${promptLine} L ${promptPoints[promptPoints.length - 1].x} ${baselineY} L ${promptPoints[0].x} ${baselineY} Z`
      : "";
  const completionArea =
    completionPoints.length > 0
      ? `${completionLine} L ${completionPoints[completionPoints.length - 1].x} ${baselineY} L ${completionPoints[0].x} ${baselineY} Z`
      : "";
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    y: baselineY - innerHeight * ratio,
    value: Math.round(trendMax * ratio),
  }));
  return {
    promptLine,
    completionLine,
    promptArea,
    completionArea,
    promptLast: promptPoints[promptPoints.length - 1] ?? null,
    completionLast: completionPoints[completionPoints.length - 1] ?? null,
    left,
    right: width - rightPadding,
    mid: left + innerWidth / 2,
    top,
    axisBottom: baselineY,
    yTicks,
  };
}
