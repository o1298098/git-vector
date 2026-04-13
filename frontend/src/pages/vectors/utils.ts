import { type VectorRow } from "./types";

export function prettyMeta(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta, null, 2);
  } catch {
    return "{}";
  }
}

export function oneLineSummary(row: VectorRow): string {
  const metadata = row.metadata || {};
  const path = typeof metadata.path === "string" ? metadata.path : (typeof metadata.file === "string" ? metadata.file : "");
  const name = typeof metadata.name === "string" ? metadata.name : "";
  const startLine = metadata.start_line;
  const endLine = metadata.end_line;
  const lines = startLine != null || endLine != null ? `L${String(startLine ?? "?")}-${String(endLine ?? startLine ?? "?")}` : "";
  return [path, name, lines].filter(Boolean).join(" · ") || row.id;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, nested]) => [key, normalizeJson(nested)]));
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}
