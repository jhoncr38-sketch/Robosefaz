// Etapas mostradas no card "Agora" do Dashboard.

import type { JobStatus } from "@/lib/types";

export const JOB_STEPS = ["Na fila", "Abrindo SIAT", "Agendando exportações", "Aguardando SEFAZ", "Baixando ZIPs"] as const;

/** Índice da etapa atual (0 a 4); -1 para jobs finalizados ou parados para intervenção. */
export function jobStepIndex(status: JobStatus): number {
  switch (status) {
    case "queued":
      return 0;
    case "starting":
    case "opening_browser":
    case "opening_siat":
    case "waiting_certificate":
    case "authenticating":
    case "selecting_taxpayer":
    case "opening_siat_module":
    case "navigating_export":
      return 1;
    case "scheduling_nfce":
    case "scheduling_nfe_issued":
    case "scheduling_nfe_received":
      return 2;
    case "waiting_sefaz":
    case "checking_processing":
      return 3;
    case "download_available":
    case "downloading":
    case "organizing_files":
      return 4;
    default:
      return -1;
  }
}
