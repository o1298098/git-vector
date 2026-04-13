type EnqueuePageHeaderProps = {
  title: string;
  subtitle: string;
};

export function EnqueuePageHeader({ title, subtitle }: EnqueuePageHeaderProps) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground">{subtitle}</p>
    </div>
  );
}
