import type { CertificateStatus } from "@/lib/types";

export interface PlannerClient {
  id: string;
  client_code: string;
  legal_name: string;
  trade_name: string | null;
  cnpj: string;
  active: boolean;
  uses_nfce: boolean;
  uses_nfe_issued: boolean;
  uses_nfe_received: boolean;
  certificate_status: CertificateStatus | null;
  certificate_valid_until: string | null;
}
