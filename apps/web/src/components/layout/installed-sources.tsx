import type { SourceView } from "@runelay/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { Skeleton } from "@/components/ui/display/skeleton";
import { UI_SPRING } from "@/components/ui/display/spring";
import { useT } from "@/lib/i18n";
import { sourcesQuery } from "@/modules/sources/api/sources.api";
import { InstalledSourceGroup } from "./installed-source-group";
import { InstalledSourceLink } from "./installed-source-link";
import { PanelSection } from "./panel-section";

const PLACEHOLDERS = [0, 1, 2];

const groupByConnector = (sources: SourceView[]) => {
  const groups = new Map<string, SourceView[]>();
  for (const source of sources) {
    const base = source.name.replace(/_\d+$/, "");
    groups.set(base, [...(groups.get(base) ?? []), source]);
  }
  return [...groups].map(([name, items]) => ({ name, items }));
};

interface InstalledSourcesProps {
  onNavigate?: () => void;
}

export function InstalledSources({ onNavigate }: InstalledSourcesProps) {
  const t = useT();
  const { data: sources, isPending } = useQuery(sourcesQuery);

  return (
    <PanelSection label="layout.nav.installed" collapsible>
      {isPending && PLACEHOLDERS.map((item) => <Skeleton key={item} className="mx-2.5 my-1.5 h-5 bg-sidebar-active" />)}
      {sources?.length === 0 && (
        <Link
          to="/connectors"
          onClick={onNavigate}
          className="px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors duration-200 hover:text-foreground"
        >
          {t("layout.shell.noConnectors")}
        </Link>
      )}
      <ul className="flex flex-col gap-0.5">
        <AnimatePresence initial={false}>
          {groupByConnector(sources ?? []).map((group) => (
            <motion.li
              key={group.name}
              layout
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ ...UI_SPRING, mass: 0.7 }}
              className="overflow-hidden"
            >
              {group.items.length > 1 ? (
                <InstalledSourceGroup name={group.name} sources={group.items} onNavigate={onNavigate} />
              ) : (
                <InstalledSourceLink source={group.items[0]} onNavigate={onNavigate} />
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </PanelSection>
  );
}
