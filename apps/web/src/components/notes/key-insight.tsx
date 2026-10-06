import { Building2, KeyRound, Lock, ShieldAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { formatDoc } from "@/lib/danfe";
import { type InsightClient, type KeyInsight, UF_NAME } from "@/lib/key-insight";
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

/**
 * Chave que não está no índice: mostra o que ela revela e prepara a busca no SIAT com o
 * certificado da empresa certa (o botão fica pronto para a etapa 3).
 */
export function KeyInsightCard({ insight, emitter }: { insight: KeyInsight; emitter: { nome: string; cidade: string } | null }) {
  const emitName = insight.emitClient?.name ?? emitter?.nome ?? null;
  const uf = UF_NAME[insight.uf] ?? insight.uf;
  const choosable = insight.situation === "emitida-cliente" || insight.situation === "recebida-escolher";

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
        </div>
      </div>

      {choosable ? (
        <form className="flex flex-col gap-3 rounded-lg border border-(--c-e8e8e4) px-4 py-3.5">
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="font-medium">Buscar no SIAT com o certificado de</span>
            <select
              name="client"
              defaultValue={insight.preselected ?? ""}
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
              type="button"
              disabled
              title="Etapa 3: o robô entra no SIAT com o certificado escolhido e exporta a nota pela chave"
              className="flex h-9 cursor-not-allowed items-center gap-2 rounded-lg bg-(--c-a9cdb8) px-4 text-[13px] font-medium text-white"
            >
              <Lock className="size-3.5" /> Buscar no SIAT · em breve
            </button>
            <span className="text-xs text-(--c-6b6c66)">
              O robô vai entrar no SIAT como essa empresa, exportar a nota pela chave e trazê-la para cá (2 a 4 min).
            </span>
          </div>
        </form>
      ) : null}

      {insight.situation === "recebida-escolher" && insight.missingRecipients.length > 0 ? (
        <p className="flex items-start gap-2 text-xs text-(--c-6b6c66)">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Enquanto a busca no SIAT não está pronta: se a empresa que comprou estiver entre as que ainda não tiveram as NF-e
            recebidas de {insight.anoMes} baixadas, agendar esse mês em{" "}
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
