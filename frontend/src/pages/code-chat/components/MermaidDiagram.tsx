import { useEffect, useId, useState } from "react";
import { useI18n } from "@/i18n/I18nContext";
import { useTheme } from "@/theme/ThemeContext";

type Props = {
  code: string;
};

let lastMermaidTheme: boolean | null = null;

/**
 * 将 ```mermaid 围栏渲染为 SVG（与 ThemeContext 深浅色同步）。
 * 使用动态 import，避免首屏加载整包 mermaid。
 */
export function MermaidDiagram({ code }: Props) {
  const { t } = useI18n();
  const { resolvedDark } = useTheme();
  const baseId = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = code.replace(/\n$/, "").trim();
    if (!trimmed) {
      setSvg("");
      setErr(null);
      return;
    }

    let cancelled = false;

    const run = async () => {
      try {
        const mod = await import("mermaid");
        const mm = mod.default;
        if (lastMermaidTheme !== resolvedDark) {
          mm.initialize({
            startOnLoad: false,
            theme: resolvedDark ? "dark" : "default",
            securityLevel: "strict",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          });
          lastMermaidTheme = resolvedDark;
        }
        const graphId = `gv-mermaid-${baseId}-${Math.random().toString(36).slice(2, 11)}`;
        const { svg: out } = await mm.render(graphId, trimmed);
        if (!cancelled) {
          setSvg(out);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          setSvg("");
          setErr(e instanceof Error ? e.message : String(e));
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [code, resolvedDark, baseId]);

  if (err) {
    return (
      <div className="space-y-2 px-1 py-2">
        <p className="text-xs text-destructive">
          {t("chat.mermaidRenderError")}：{err}
        </p>
        <pre className="max-h-48 overflow-auto rounded-md border border-destructive/20 bg-muted/40 p-2 font-mono text-xs leading-relaxed">
          {code.replace(/\n$/, "")}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return <div className="h-28 animate-pulse rounded-md bg-muted/60" aria-busy="true" aria-label={t("common.loading")} />;
  }

  return (
    <div
      className="gv-mermaid-svg overflow-x-auto rounded-md border border-black/10 bg-background px-2 py-3 dark:border-white/10 [&_svg]:h-auto [&_svg]:max-w-full"
      // eslint-disable-next-line react/no-danger -- mermaid 官方输出受控 SVG
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
