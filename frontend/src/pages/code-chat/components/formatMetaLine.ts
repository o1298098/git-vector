export function formatMetaLine(meta: Record<string, unknown>, linesLabel: string): string | null {
  const path = meta.path ?? meta.file;
  const name = meta.name;
  const sl = meta.start_line;
  const el = meta.end_line;
  const parts: string[] = [];
  if (path != null && String(path)) parts.push(String(path));
  if (name != null && String(name)) parts.push(String(name));
  if (sl != null || el != null) {
    parts.push(`${linesLabel} ${sl ?? "?"}-${el ?? sl ?? "?"}`);
  }
  return parts.length ? parts.join(" · ") : null;
}
