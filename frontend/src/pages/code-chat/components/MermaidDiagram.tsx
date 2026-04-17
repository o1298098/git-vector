import { useEffect, useId, useMemo, useState } from "react";
import { Expand, X } from "lucide-react";
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
  const [previewOpen, setPreviewOpen] = useState(false);

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

  useEffect(() => {
    if (!previewOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPreviewOpen(false);
      }
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [previewOpen]);

  const diagramMarkup = useMemo(
    () => ({ __html: svg }),
    [svg],
  );

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
    <>
      <button
        type="button"
        className="group relative block w-full rounded-md text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        onClick={() => setPreviewOpen(true)}
        aria-label={t("chat.mermaidPreviewExpand")}
        title={t("chat.mermaidPreviewOpen")}
      >
        <div
          className="gv-mermaid-svg overflow-x-auto rounded-md border border-black/10 bg-background px-2 py-3 dark:border-white/10 [&_svg]:h-auto [&_svg]:max-w-full"
          // eslint-disable-next-line react/no-danger -- mermaid 官方输出受控 SVG
          dangerouslySetInnerHTML={diagramMarkup}
        />
        <div className="pointer-events-none absolute inset-x-3 top-3 flex items-center justify-end opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/95 px-2.5 py-1 text-xs text-foreground shadow-sm">
            <Expand className="size-3.5" aria-hidden />
            {t("chat.mermaidPreviewOpen")}
          </span>
        </div>
      </button>

      {previewOpen ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 px-3 py-6 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-label={t("chat.mermaidPreviewFullscreen")}
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="relative flex max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">{t("chat.mermaidPreviewTitle")}</div>
                <div className="text-xs text-muted-foreground">{t("chat.mermaidPreviewHint")}</div>
              </div>
              <button
                type="button"
                className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                onClick={() => setPreviewOpen(false)}
                aria-label={t("chat.mermaidPreviewClose")}
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <div className="overflow-auto bg-background p-4 md:p-6">
              <div
                className="gv-mermaid-svg min-w-max rounded-xl border border-black/10 bg-background px-4 py-4 dark:border-white/10 [&_svg]:h-auto [&_svg]:max-w-none"
                // eslint-disable-next-line react/no-danger -- mermaid 官方输出受控 SVG
                dangerouslySetInnerHTML={diagramMarkup}
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
