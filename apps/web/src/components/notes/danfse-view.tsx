import { formatDoc, formatMoney } from "@/lib/danfe";
import type { DanfseData, DanfseParty } from "@/lib/danfse";
import { formatDateTime } from "@/lib/format";
import { formatKey } from "@/lib/nfe-key";
import { cn } from "@/lib/utils";

/** Visualização da NFS-e no formato da DANFSe, montada a partir do XML (conferência; o documento fiscal é o XML). */

function Cell({ label, children, className, mono = false }: { label: string; children: React.ReactNode; className?: string; mono?: boolean }) {
  return (
    <div className={cn("min-w-0 border-r border-(--c-e3e3df) px-3 py-2 last:border-r-0", className)}>
      <div className="mb-[3px] text-[10px] tracking-[0.06em] text-(--c-6b6c66) uppercase">{label}</div>
      <div className={cn("text-[13px] break-words text-foreground", mono && "font-mono")}>{children || "—"}</div>
    </div>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-b border-(--c-e3e3df) bg-(--c-fafaf8) px-3 py-1.5 text-[10.5px] tracking-[0.06em] text-(--c-6b6c66) uppercase">
      {children}
    </div>
  );
}

function Row({ cols, children }: { cols: string; children: React.ReactNode }) {
  return (
    <div className="grid border-b border-(--c-e3e3df) last:border-b-0" style={{ gridTemplateColumns: cols }}>
      {children}
    </div>
  );
}

function formatCep(cep: string): string {
  const d = cep.replace(/\D/g, "");
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : cep;
}

function address(p: DanfseParty): string {
  return [p.endereco, [p.municipio, p.uf].filter(Boolean).join("/"), p.cep ? `CEP ${formatCep(p.cep)}` : ""].filter(Boolean).join(" · ");
}

function PartyRows({ title, p }: { title: string; p: DanfseParty }) {
  return (
    <>
      <Section>{title}</Section>
      <Row cols="2fr 1fr 1fr">
        <Cell label="Nome / razão social">{p.nome}</Cell>
        <Cell label="CNPJ / CPF" mono>
          {p.doc ? formatDoc(p.doc) : ""}
        </Cell>
        <Cell label="Inscrição municipal" mono>
          {p.im}
        </Cell>
      </Row>
      <Row cols="2fr 1fr">
        <Cell label="Endereço">{address(p)}</Cell>
        <Cell label="E-mail">{p.email}</Cell>
      </Row>
    </>
  );
}

export function DanfseView({ data, canceled = false }: { data: DanfseData; canceled?: boolean }) {
  const v = data.valores;
  const competencia = data.competencia ? data.competencia.slice(0, 7).split("-").reverse().join("/") : "";
  return (
    <div className="relative overflow-hidden rounded-[10px] border border-(--c-d9d9d4) bg-card text-foreground">
      {canceled ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="-rotate-12 rounded-md border-4 border-(--c-b42323)/50 px-6 py-2 text-4xl font-bold tracking-[0.2em] text-(--c-b42323)/50">
            CANCELADA
          </span>
        </div>
      ) : null}
      <Row cols="1.4fr 1fr">
        <div className="flex flex-col justify-center gap-1 border-r border-(--c-e3e3df) px-3 py-2">
          <b className="text-xl tracking-[0.08em]">DANFSe</b>
          <span className="text-[10.5px] leading-[1.3] text-(--c-6b6c66)">Documento Auxiliar da Nota Fiscal de Serviço Eletrônica</span>
        </div>
        <div className="grid grid-cols-2">
          <Cell label="Número da NFS-e" mono>
            {data.numero}
          </Cell>
          <Cell label="Competência" mono>
            {competencia}
          </Cell>
          <Cell label="Emissão" className="col-span-2 border-t border-(--c-e3e3df)">
            {formatDateTime(data.emissao)}
          </Cell>
        </div>
      </Row>
      <Row cols="1fr">
        <Cell label="Chave de acesso" mono>
          {formatKey(data.chave)}
        </Cell>
      </Row>
      <Row cols="1fr 1fr 1fr">
        <Cell label="DPS (série / número)" mono>
          {[data.serieDps, data.numeroDps].filter(Boolean).join(" / ")}
        </Cell>
        <Cell label="Situação" mono>
          {data.cStat === "100" ? "100 · gerada" : data.cStat}
        </Cell>
        <Cell label="Regime">{data.simples}</Cell>
      </Row>

      <PartyRows title="Prestador do serviço" p={data.prestador} />
      {data.tomador ? <PartyRows title="Tomador do serviço" p={data.tomador} /> : null}

      <Section>Serviço</Section>
      <Row cols="1fr 3fr">
        <Cell label="Código nacional" mono>
          {data.servico.codigo}
        </Cell>
        <Cell label="Descrição do código">{data.servico.descricaoCodigo}</Cell>
      </Row>
      <Row cols="1fr">
        <Cell label="Descrição do serviço">
          <span className="whitespace-pre-line">{data.servico.descricao}</span>
        </Cell>
      </Row>
      <Row cols="1fr 1fr">
        <Cell label="Local da prestação">{data.servico.localPrestacao}</Cell>
        <Cell label="Município de incidência do ISS">{data.servico.localIncidencia}</Cell>
      </Row>

      <Section>Valores</Section>
      <Row cols="repeat(4, 1fr)">
        <Cell label="Valor do serviço" mono>
          R$ {formatMoney(v.servico)}
        </Cell>
        <Cell label="Base de cálculo" mono>
          {v.baseCalculo ? `R$ ${formatMoney(v.baseCalculo)}` : ""}
        </Cell>
        <Cell label="Alíquota" mono>
          {v.aliquota ? `${v.aliquota.replace(".", ",")}%` : ""}
        </Cell>
        <Cell label="ISS" mono>
          {v.iss ? `R$ ${formatMoney(v.iss)}${v.issRetido ? " (retido)" : ""}` : v.issRetido ? "retido" : ""}
        </Cell>
      </Row>
      <Row cols="1fr 1fr">
        <Cell label="Total de retenções" mono>
          {v.retencoes ? `R$ ${formatMoney(v.retencoes)}` : ""}
        </Cell>
        <Cell label="Valor líquido" mono className="bg-(--c-f3faf6)">
          <b>R$ {formatMoney(v.liquido || v.servico)}</b>
        </Cell>
      </Row>
    </div>
  );
}
