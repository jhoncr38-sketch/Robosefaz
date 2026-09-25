"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { competenceBounds, formatCompetence, recentCompetences } from "@/lib/competence";

export function CompetenceSelect({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
}) {
  const options = recentCompetences(24);
  const bounds = competenceBounds(value);
  return (
    <div className="space-y-1">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-40">
          <SelectValue placeholder="MM/AAAA" />
        </SelectTrigger>
        <SelectContent>
          {options.map((c) => (
            <SelectItem key={c} value={c}>
              {formatCompetence(c)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {bounds ? (
        <p className="text-xs text-muted-foreground">
          Período: {bounds.start} a {bounds.end}
        </p>
      ) : null}
    </div>
  );
}
