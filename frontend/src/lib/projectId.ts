/** 与后端 app/wiki_generator._safe_project_id 一致：目录名安全化 */
export function safeProjectId(projectId: string): string {
  return [...projectId]
    .map((c) => {
      if (c === "-" || c === "_") return c;
      if (/[\p{L}\p{N}]/u.test(c)) return c;
      return "_";
    })
    .join("");
}
