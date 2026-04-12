// 常用语言合集，避免逐语言注册
import hljs from "highlight.js/lib/common";

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  fs: "fsharp",
};

/** 语义高亮 fenced code；用于检索结果块与 Markdown 助手气泡 */
export function highlightMarkdownCode(code: string, rawLang: string): { html: string; lang: string } {
  const trimmed = code.replace(/\s+$/, "");
  const lang = rawLang.trim().toLowerCase();
  const resolved = lang ? LANG_ALIASES[lang] ?? lang : "plaintext";

  try {
    if (resolved !== "plaintext" && hljs.getLanguage(resolved)) {
      const { value } = hljs.highlight(trimmed, { language: resolved, ignoreIllegals: true });
      return { html: value, lang: resolved };
    }
  } catch {
    /* fall through */
  }

  const auto = hljs.highlightAuto(trimmed);
  return { html: auto.value, lang: auto.language ?? "plaintext" };
}
