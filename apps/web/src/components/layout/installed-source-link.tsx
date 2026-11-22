import type { SourceView } from "@runelay/shared";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { ConnectorIcon } from "@/modules/catalog/components/connector-icon";
import { SourceStatusDot } from "@/modules/sources/components/source-status-dot";

interface InstalledSourceLinkProps {
  source: SourceView;
  onNavigate?: () => void;
  nested?: boolean;
}

export function InstalledSourceLink({ source, onNavigate, nested = false }: InstalledSourceLinkProps) {
  return (
    <Link
      to="/connectors/$name"
      params={{ name: source.name }}
      onClick={onNavigate}
      className={cn(
        "flex min-h-11 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors duration-200 hover:bg-sidebar-active hover:text-foreground data-[status=active]:bg-sidebar-active data-[status=active]:text-foreground lg:min-h-8",
        nested && "font-normal",
      )}
    >
      {!nested && <ConnectorIcon name={source.name} icon={source.icon} size="sm" />}
      <span className="min-w-0 flex-1 truncate">{nested ? (source.google?.email ?? source.name) : source.name}</span>
      <SourceStatusDot status={source.status} enabled={source.enabled} />
    </Link>
  );
}
