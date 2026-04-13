import { type ReactNode } from "react";
import { useTheme } from "@/theme/ThemeContext";
import { LoginInkFlowField } from "./LoginInkFlowField";

type LoginSceneProps = {
  children: ReactNode;
};

export function LoginScene({ children }: LoginSceneProps) {
  const { resolvedDark } = useTheme();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-[#040816] dark:text-white">
      <div className="grid min-h-screen md:grid-cols-[minmax(0,1fr)_minmax(360px,460px)] lg:grid-cols-[minmax(0,1fr)_minmax(380px,520px)]">
        <section className="relative hidden overflow-hidden md:block">
          <LoginInkFlowField dark={resolvedDark} />
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_24%_20%,rgba(56,189,248,0.12),transparent_44%),radial-gradient(circle_at_78%_72%,rgba(129,140,248,0.12),transparent_46%),linear-gradient(155deg,rgba(255,255,255,0.02),rgba(226,232,240,0.16))] dark:bg-[radial-gradient(circle_at_22%_22%,rgba(52,118,132,0.07),transparent_48%),radial-gradient(circle_at_76%_70%,rgba(88,72,128,0.06),transparent_50%),linear-gradient(155deg,rgba(2,6,23,0.02),rgba(2,6,23,0.12))]" />
        </section>

        <section className="relative flex items-center justify-center bg-slate-100 px-4 py-10 sm:px-6 md:px-10 dark:bg-[#060b1d]">
          <div className="relative z-10 w-full max-w-md">{children}</div>
        </section>
      </div>
    </div>
  );
}
