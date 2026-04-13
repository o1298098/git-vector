import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KeyRound, UserRound } from "lucide-react";

type LoginFormCardProps = {
  user: string;
  password: string;
  loading: boolean;
  error: string | null;
  onUserChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  text: {
    title: string;
    subtitle: string;
    userLabel: string;
    passwordLabel: string;
    submitting: string;
    submit: string;
  };
};

export function LoginFormCard({
  user,
  password,
  loading,
  error,
  onUserChange,
  onPasswordChange,
  onSubmit,
  text,
}: LoginFormCardProps) {
  return (
    <div className="w-full max-w-md text-slate-900 dark:text-slate-50">
      <div className="mb-8 space-y-2">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700/90 dark:text-cyan-200/85">Admin Console</p>
        <h1 className="text-4xl font-semibold tracking-tight text-slate-900 dark:text-white">
          {text.title}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">{text.subtitle}</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-6">
        <div className="space-y-2.5">
          <Label htmlFor="user" className="text-slate-700 dark:text-slate-200">
            {text.userLabel}
          </Label>
          <div className="relative">
            <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500 dark:text-slate-400" />
            <Input
              id="user"
              autoComplete="username"
              value={user}
              onChange={(event) => onUserChange(event.target.value)}
              className="h-12 rounded-xl border-slate-300 bg-white pl-10 text-slate-900 placeholder:text-slate-500 focus-visible:ring-cyan-500/50 dark:border-white/20 dark:bg-white/10 dark:text-white dark:placeholder:text-slate-400 dark:focus-visible:ring-cyan-300/60"
            />
          </div>
        </div>
        <div className="space-y-2.5">
          <Label htmlFor="pass" className="text-slate-700 dark:text-slate-200">
            {text.passwordLabel}
          </Label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500 dark:text-slate-400" />
            <Input
              id="pass"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              className="h-12 rounded-xl border-slate-300 bg-white pl-10 text-slate-900 placeholder:text-slate-500 focus-visible:ring-cyan-500/50 dark:border-white/20 dark:bg-white/10 dark:text-white dark:placeholder:text-slate-400 dark:focus-visible:ring-cyan-300/60"
            />
          </div>
        </div>
        {error ? <p className="rounded-lg border border-rose-300/60 bg-rose-500/12 px-3 py-2 text-sm text-rose-700 dark:border-rose-300/30 dark:bg-rose-500/15 dark:text-rose-200">{error}</p> : null}
        <Button
          type="submit"
          className="h-12 w-full rounded-xl bg-primary text-base font-medium text-primary-foreground hover:bg-primary/90"
          disabled={loading}
        >
          {loading ? text.submitting : text.submit}
        </Button>
      </form>
    </div>
  );
}
