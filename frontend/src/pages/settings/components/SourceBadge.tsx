import { cn } from "@/lib/utils";

type SourceBadgeProps = {
  source: string;
  labelOverride: string;
  labelEnv: string;
};

export function SourceBadge({ source, labelOverride, labelEnv }: SourceBadgeProps) {
  const override = source === "override";
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        override ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {override ? labelOverride : labelEnv}
    </span>
  );
}
