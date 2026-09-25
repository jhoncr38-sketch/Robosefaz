import Link from "next/link";

import { cn } from "@/lib/utils";

const ACCENT: Record<string, string> = {
  neutral: "text-zinc-500 bg-zinc-100",
  green: "text-emerald-600 bg-emerald-50",
  blue: "text-sky-600 bg-sky-50",
  yellow: "text-amber-600 bg-amber-50",
  red: "text-red-600 bg-red-50",
  orange: "text-orange-600 bg-orange-50",
};

export function StatCard({
  label,
  value,
  icon,
  accent = "neutral",
  hint,
  href,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  accent?: keyof typeof ACCENT;
  hint?: string;
  href?: string;
}) {
  const body = (
    <div className="flex items-start justify-between gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-zinc-300">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
        {hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className={cn("rounded-lg p-2 [&_svg]:size-4", ACCENT[accent])}>{icon}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
      {body}
    </Link>
  ) : (
    body
  );
}
