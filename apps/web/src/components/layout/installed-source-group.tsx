import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SourceView } from "@runelay/shared";
import { useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { ConnectorIcon } from "@/modules/catalog/components/connector-icon";
import { SourceStatusDot } from "@/modules/sources/components/source-status-dot";
import { InstalledSourceLink } from "./installed-source-link";

interface InstalledSourceGroupProps {
  name: string;
  sources: SourceView[];
  onNavigate?: () => void;
}

const STATUS_WEIGHT = { error: 3, needs_auth: 2, idle: 1, ok: 0 } as const;

const worstSource = (sources: SourceView[]) =>
  sources.reduce((worst, source) => {
    if (!source.enabled) return worst;
    if (!worst.enabled) return source;
    return STATUS_WEIGHT[source.status] > STATUS_WEIGHT[worst.status] ? source : worst;
  });

export function InstalledSourceGroup({ name, sources, onNavigate }: InstalledSourceGroupProps) {
  const { pathname } = useLocation();
  const [toggled, setToggled] = useState<boolean | null>(null);
  const hasActive = sources.some((source) => pathname === `/connectors/${source.name}`);
  const open = toggled ?? hasActive;
  const summary = worstSource(sources);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setToggled(!open)}
        className="group flex min-h-11 items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium text-muted-foreground outline-none transition-colors duration-200 hover:bg-sidebar-active hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/25 lg:min-h-8"
      >
        <ConnectorIcon name={name} icon={sources[0].icon} size="sm" />
        <span className="min-w-0 truncate">{name}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground/70">{sources.length}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={12}
          strokeWidth={2}
          className={cn("text-muted-foreground/70 transition-transform duration-200 ease-out", !open && "-rotate-90")}
        />
        <span className="flex-1" />
        <SourceStatusDot status={summary.status} enabled={summary.enabled} />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
        inert={!open || undefined}
      >
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-hidden pt-0.5">
          {sources.map((source) => (
            <li
              key={source.name}
              className="relative pl-8 before:absolute before:top-0 before:left-5 before:h-1/2 before:w-3 before:rounded-bl-md before:border-b before:border-l before:border-border after:absolute after:top-0 after:-bottom-0.5 after:left-5 after:border-l after:border-border first:after:-top-2 last:after:hidden"
            >
              <InstalledSourceLink source={source} onNavigate={onNavigate} nested />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
