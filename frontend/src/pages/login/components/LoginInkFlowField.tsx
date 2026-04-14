import { useEffect, useRef } from "react";

type LoginInkFlowFieldProps = {
  dark: boolean;
};

type Rgb = { r: number; g: number; b: number };

function emitterPositions(timeMs: number, width: number, height: number) {
  const t = timeMs * 0.00009;
  const cx1 = width * 0.22;
  const cy1 = height * 0.34;
  const cx2 = width * 0.52;
  const cy2 = height * 0.62;
  const cx3 = width * 0.78;
  const cy3 = height * 0.38;
  return [
    {
      x: cx1 + Math.cos(t * 1.05) * width * 0.1,
      y: cy1 + Math.sin(t * 1.55) * height * 0.14,
    },
    {
      x: cx2 + Math.cos(t * 1.35 + 2.2) * width * 0.11,
      y: cy2 + Math.sin(t * 1.15 + 0.6) * height * 0.11,
    },
    {
      x: cx3 + Math.cos(t * 1.5 + 4.1) * width * 0.09,
      y: cy3 + Math.sin(t * 1.45 + 3.0) * height * 0.13,
    },
  ];
}

export function LoginInkFlowField({ dark }: LoginInkFlowFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let stopped = false;

    const baseDark = { r: 4, g: 8, b: 22 };
    const baseLight = { r: 248, g: 250, b: 252 };

    /** 暗色主题：进一步压暗色值，避免球体在深色背景上过亮 */
    const inkDark: Rgb[] = [
      { r: 34, g: 78, b: 92 },
      { r: 60, g: 52, b: 94 },
      { r: 92, g: 56, b: 40 },
    ];
    const inkLight: Rgb[] = [
      { r: 130, g: 198, b: 232 },
      { r: 188, g: 168, b: 232 },
      { r: 228, g: 188, b: 168 },
    ];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const { clientWidth, clientHeight } = canvas;
      if (clientWidth < 1 || clientHeight < 1) return;
      canvas.width = Math.floor(clientWidth * dpr);
      canvas.height = Math.floor(clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const paintBase = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w < 1 || h < 1) return;
      const b = dark ? baseDark : baseLight;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = `rgb(${b.r},${b.g},${b.b})`;
      ctx.fillRect(0, 0, w, h);
    };

    paintBase();

    const loop = (now: number) => {
      if (stopped) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w >= 1 && h >= 1) {
        const base = dark ? baseDark : baseLight;
        ctx.globalCompositeOperation = "source-over";
        const fadeA = dark ? 0.082 : 0.11;
        ctx.fillStyle = `rgba(${base.r},${base.g},${base.b},${fadeA})`;
        ctx.fillRect(0, 0, w, h);

        const inks = dark ? inkDark : inkLight;
        ctx.globalCompositeOperation = dark ? "screen" : "multiply";

        const pts = emitterPositions(now, w, h);
        const r = Math.min(w, h) * 0.26;
        pts.forEach((p, i) => {
          const c = inks[i];
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          const core = dark ? 0.19 : 0.14;
          const mid = dark ? 0.06 : 0.055;
          g.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${core})`);
          g.addColorStop(0.5, `rgba(${c.r},${c.g},${c.b},${mid})`);
          g.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      raf = window.requestAnimationFrame(loop);
    };

    raf = window.requestAnimationFrame(loop);

    return () => {
      stopped = true;
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [dark]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full opacity-100 blur-[18px] saturate-100 contrast-[1.02] dark:saturate-[0.72] dark:contrast-[0.94]"
      aria-hidden
    />
  );
}
