import { Bot, Building2, KeyRound, ShieldAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { searchNoteInSiat } from "@/app/actions/notes";
import { formatDoc } from "@/lib/danfe";
import { canSearchInSiat, type InsightClient, type KeyInsight, UF_NAME } from "@/lib/key-insight";
import { formatKey } from "@/lib/nfe-key";
import { cn } from "@/lib/utils";

function Fact({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] tracking-[0.05em] text-(--c-6b6c66) uppercase">{label}</div>
      <div className={cn("text-[13px] font-medium", mono && "font-mono")}>{children}</div>
    </div>
  );
}

function Group({ label, items }: { label: string; items: InsightClient[] }) {
  if (items.length === 0) return null;
  return (
    <optgroup label={label}>
      {items.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} · {c.client_code}
        </option>
      ))}
    </optgroup>
  );
}

/** o que aconteceu na última busca desta chave no SIAT (trabalho já encerrado) */
export interface LastSearch {
  id: string;
  status: "completed" | "failed" | "cancelled";
  clientId: string;
  clientName: string;
  message: string | null;
}

/**
 * Chave que não está no índice: mostra o que ela revela e deixa a pessoa mandar o robô buscar a
 * nota no SIAT com o certificado da empresa certa.
 */
export function KeyInsightCard({
  insight,
  emitter,
  canRun,
  lastSearch = null,
  error = null,
}: {
  insight: KeyInsight;
  emitter: { nome: string; cidade: string } | null;
  /** a pessoa pode disparar automações (operador/administrador) */
  canRun: boolean;
  lastSearch?: LastSearch | null;
  /** erro devolvido ao tentar criar a busca */
  error?: string | null;
}) {
  const emitName = insight.emitClient?.name ?? emitter?.nome ?? null;
  const uf = UF_NAME[insight.uf] ?? insight.uf;
  const searchable = canSearchInSiat(insight);
  const preselected = lastSearch?.status === "completed" ? "" : (insight.preselected ?? "");

  return (
    <div className="flex flex-col gap-4 px-4 py-5">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-(--c-e6f4ec) text-primary">
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-semibold">Esta nota ainda não está nos arquivos baixados</p>
          <p className="mt-0.5 font-mono text-xs text-(--c-6b6c66)">{formatKey(insight.key)}</p>
        </div>
      </div>

      {!insight.valid ? (
        <div className="flex items-start gap-2 rounded-lg border border-(--c-f0c9c9) bg-(--c-fdecec) px-3 py-2.5 text-[13px] text-(--c-b42323)">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            O dígito verificador não confere: parece erro de digitação. Confira a chave na DANFE (são 44 números) e tente
            de novo.
          </span>
        </div>
      ) : null}

      <div className="grid gap-3 rounded-lg border border-(--c-e8e8e4) bg-(--c-fafaf8) px-4 py-3 sm:grid-cols-3 lg:grid-cols-5">
        <Fact label="Documento">{insight.modeloLabel}</Fact>
        <Fact label="Número · série" mono>
          {insight.numero.toLocaleString("pt-BR")} · {insight.serie}
        </Fact>
        <Fact label="Emitida em" mono>
          {insight.anoMes}
        </Fact>
        <Fact label="Estado do emitente">{uf}</Fact>
        <Fact label="CNPJ do emitente" mono>
          {formatDoc(insight.emitCnpj)}
        </Fact>
      </div>

      <div className="flex items-start gap-2.5 text-[13px]">
        <Building2 className="mt-0.5 size-4 shrink-0 text-(--c-6b6c66)" />
        <div className="min-w-0">
          <p>
            <span className="text-(--c-6b6c66)">Emitente: </span>
            <span className="font-medium">{emitName ?? "não identificado"}</span>
            {!insight.emitClient && emitter?.cidade ? <span className="text-(--c-6b6c66)"> · {emitter.cidade}</span> : null}
          </p>
          {insight.emitClient ? (
            <p className="text-(--c-1c7a47)">
              É cliente do escritório ({insight.emitClient.client_code}): a nota foi <b>emitida</b> por ele.
            </p>
          ) : insight.situation === "nfce-fora" ? (
            <p className="text-(--c-6b6c66)">
              Não é cliente do escritório. Como é uma NFC-e (nota ao consumidor), ela só existe para quem emitiu; não há
              como o escritório baixá-la.
            </p>
          ) : (
            <p className="text-(--c-6b6c66)">
              Não é cliente do escritório. Então esta nota foi <b>recebida</b> por algum cliente seu, e a chave não diz
              qual: escolha abaixo a empresa que comprou.
            </p>
          )}
          {insight.emitClient && insight.modelo === "65" ? (
            <p className="text-(--c-6b6c66)">
              NFC-e não tem busca pela chave no SIAT: ela vem junto com as NFC-e do mês em{" "}
              <Link href={`/automation?competence=${insight.competence}`} className="font-medium text-primary">
                Executar automações
              </Link>
              .
            </p>
          ) : null}
        </div>
      </div>

      {lastSearch ? (
        <div
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]",
            lastSearch.status === "completed"
              ? "border-(--c-f0dca8) bg-(--c-fdf4e3) text-(--c-9a6205)"
              : "border-(--c-f0c9c9) bg-(--c-fdecec) text-(--c-b42323)",
          )}
        >
          <Bot className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {lastSearch.status === "completed" ? (
              <>
                O robô entrou no SIAT com o certificado de <b>{lastSearch.clientName}</b> e{" "}
                {lastSearch.message?.toLowerCase().includes("não encontrada")
                  ? "a nota não apareceu para essa empresa. Se ela foi recebida por outro cliente, escolha-o abaixo e busque de novo."
                  : "a busca terminou sem trazer a nota para cá."}
              </>
            ) : (
              <>
                A última busca com o certificado de <b>{lastSearch.clientName}</b>{" "}
                {lastSearch.status === "cancelled" ? "foi cancelada" : "falhou"}
                {lastSearch.message ? `: ${lastSearch.message}` : "."}
              </>
            )}{" "}
            <Link href={`/history/${lastSearch.id}`} className="font-medium underline">
              Ver os passos
            </Link>
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-(--c-f0c9c9) bg-(--c-fdecec) px-3 py-2.5 text-[13px] text-(--c-b42323)">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {searchable ? (
        <form action={searchNoteInSiat} className="flex flex-col gap-3 rounded-lg border border-(--c-e8e8e4) px-4 py-3.5">
          <input type="hidden" name="chave" value={insight.key} />
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="font-medium">Buscar no SIAT com o certificado de</span>
            <select
              name="client_id"
              required
              defaultValue={preselected}
              className="h-9 rounded-lg border border-input bg-card px-2.5 text-[13px] outline-none focus:border-ring"
            >
              <option value="">Escolha a empresa…</option>
              {insight.emitClient ? (
                <optgroup label="Emitente da nota (pela chave)">
                  <option value={insight.emitClient.id}>
                    {insight.emitClient.name} · {insight.emitClient.client_code}
                  </option>
                </optgroup>
              ) : null}
              <Group label="Já receberam notas deste emitente" items={insight.knownRecipients} />
              <Group label={`Mais prováveis: ainda sem as NF-e recebidas de ${insight.anoMes} baixadas`} items={insight.missingRecipients} />
              <Group label={`Já têm as recebidas de ${insight.anoMes} (a nota deveria estar no índice)`} items={insight.otherRecipients} />
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={!canRun}
              title={canRun ? undefined : "Seu perfil não pode disparar automações"}
              className="flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-[13px] font-medium text-white hover:bg-(--c-196640) disabled:cursor-not-allowed disabled:bg-(--c-a9cdb8)"
            >
              <Bot className="size-3.5" /> Buscar no SIAT
            </button>
            <span className="text-xs text-(--c-6b6c66)">
              O robô entra no SIAT como essa empresa, exporta a nota pela chave e traz o XML para cá (cerca de 1 min).
              O arquivo fica na pasta da empresa, em NF-e {insight.emitClient ? "emitidas" : "recebidas"} › Avulsas.
            </span>
          </div>
        </form>
      ) : null}

      {insight.situation === "recebida-escolher" && insight.missingRecipients.length > 0 ? (
        <p className="flex items-start gap-2 text-xs text-(--c-6b6c66)">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Outra saída: se a empresa que comprou estiver entre as que ainda não tiveram as NF-e recebidas de{" "}
            {insight.anoMes} baixadas, agendar esse mês em{" "}
            <Link href={`/automation?competence=${insight.competence}`} className="font-medium text-primary">
              Executar automações
            </Link>{" "}
            traz a nota junto com as outras.
          </span>
        </p>
      ) : null}
    </div>
  );
}
