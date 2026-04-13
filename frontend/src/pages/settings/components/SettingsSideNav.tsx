import { cn } from "@/lib/utils";

type SettingsSideNavProps = {
  ariaLabel: string;
  sections: Array<{ id: string; label: string }>;
  activeSection: string;
  onSelectSection: (id: string) => void;
};

export function SettingsSideNav({ ariaLabel, sections, activeSection, onSelectSection }: SettingsSideNavProps) {
  return (
    <aside className="shrink-0 lg:sticky lg:top-20 lg:z-10 lg:w-56 lg:self-start">
      <div className="rounded-xl border border-border/80 bg-card p-2 shadow-md ring-1 ring-black/5 dark:ring-white/10">
        <nav className="flex flex-col gap-0.5" aria-label={ariaLabel}>
          {sections.map(({ id, label }) => {
            const active = activeSection === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onSelectSection(id)}
                className={cn(
                  "w-full rounded-lg px-3 py-2.5 text-left text-sm leading-snug transition-colors",
                  active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                )}
              >
                {label}
              </button>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
