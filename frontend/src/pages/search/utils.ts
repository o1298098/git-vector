import { type Hit } from "./types";

/** 后端返回 score（越大越相关）；旧接口仅有 distance 时在前端换算 */
export function formatRelevance(hit: Hit): string {
  if (typeof hit.score === "number" && Number.isFinite(hit.score)) {
    return hit.score.toFixed(4);
  }
  if (typeof hit.distance === "number" && Number.isFinite(hit.distance)) {
    return (1 / (1 + hit.distance)).toFixed(4);
  }
  return "—";
}

export function formatMetaLine(meta: Record<string, unknown>, linesLabel: string): string | null {
  const path = meta.path ?? meta.file;
  const name = meta.name;
  const startLine = meta.start_line;
  const endLine = meta.end_line;
  const parts: string[] = [];
  if (path != null && String(path)) parts.push(String(path));
  if (name != null && String(name)) parts.push(String(name));
  if (startLine != null || endLine != null) {
    parts.push(`${linesLabel} ${startLine ?? "?"}-${endLine ?? startLine ?? "?"}`);
  }
  return parts.length ? parts.join(" · ") : null;
}
