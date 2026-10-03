import { FolderDown, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCompetence } from "@/lib/competence";
import type { BulkTarget } from "@/lib/downloads";

const HOW_TO =
  "Abre a pasta no Google Drive. Lá, clique na setinha ao lado do nome da pasta (no topo) › Fazer download: " +
  "o Drive gera um ZIP com as pastas dos clientes e dos tipos de nota.";

/**
 * "Baixar todas as notas de 09/2026" / "Baixar notas da LIA 08/2026" (notas no Google Drive):
 * as pastas ficam em ano/mês/cliente, então cada escolha é uma pasta só no Drive.
 */
export function BulkDownload({
  target,
  competence,
  clientName,
}: {
  target: BulkTarget | null;
  competence?: string;
  clientName?: string;
}) {
  if (!target || !competence) {
    return (
      <p className="mb-3 flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <FolderDown className="size-4 shrink-0" />
        Para baixar todas as notas de um mês de uma vez (organizadas por cliente), escolha a competência no filtro.
      </p>
    );
  }
  const title =
    target.kind === "client"
      ? `Notas de ${clientName ?? "este cliente"} · ${formatCompetence(competence)}`
      : `Todas as notas de ${formatCompetence(competence)}`;
  const detail =
    target.files === 0
      ? "Nenhuma nota baixada nesta competência."
      : target.kind === "client"
        ? `${target.files} arquivo${target.files > 1 ? "s" : ""}`
        : `${target.files} arquivo${target.files > 1 ? "s" : ""} de ${target.clients} cliente${target.clients > 1 ? "s" : ""}, cada um na sua pasta`;
  const label = target.kind === "client" ? "Baixar pasta do cliente" : "Baixar pasta do mês";

  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border bg-card shadow-card px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-(--c-f3faf6) text-primary">
        <FolderDown className="size-[18px]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13.5px] font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </div>
      {target.files > 0 ? (
        <div className="flex items-center gap-1.5">
          {target.folderUrl ? (
            <Button asChild size="sm">
              <a href={target.folderUrl} target="_blank" rel="noopener noreferrer" className="hover:no-underline">
                <FolderDown /> {label}
              </a>
            </Button>
          ) : (
            <Button size="sm" disabled>
              <FolderDown /> {label}
            </Button>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="text-(--c-6b6c66) hover:text-foreground" aria-label="Como baixar a pasta">
                <Info className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72 text-xs">
              {target.folderUrl
                ? HOW_TO
                : "As notas ainda não estão no Google Drive. O botão libera alguns minutos depois que elas chegam lá."}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
