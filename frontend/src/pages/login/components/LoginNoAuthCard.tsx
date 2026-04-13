import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

type LoginNoAuthCardProps = {
  title: string;
  description: string;
  enterLabel: string;
};

export function LoginNoAuthCard({ title, description, enterLabel }: LoginNoAuthCardProps) {
  return (
    <div className="w-full max-w-md space-y-5 text-slate-900 dark:text-slate-50">
      <h1 className="text-4xl font-semibold tracking-tight text-slate-900 dark:text-white">{title}</h1>
      <p className="text-sm text-slate-600 dark:text-slate-300">{description}</p>
      <Button asChild className="h-11 w-full rounded-xl bg-primary text-base font-medium text-primary-foreground hover:bg-primary/90">
        <Link to="/">{enterLabel}</Link>
      </Button>
    </div>
  );
}
