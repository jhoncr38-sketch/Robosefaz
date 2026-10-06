import { type DanfeData, type DanfeParty, formatDoc, formatMoney, formatNoteNumber, formatQty } from "@/lib/danfe";
import { formatDateTime } from "@/lib/format";
import { formatKey } from "@/lib/nfe-key";
import { cn } from "@/lib/utils";

/** Visualização da nota no formato da DANFE, montada a partir do XML (conferência; o documento fiscal é o XML). */

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

function address(p: DanfeParty): string {
  return [p.endereco, [p.municipio, p.uf].filter(Boolean).join("/"), p.cep ? `CEP ${formatCep(p.cep)}` : ""].filter(Boolean).join(" · ");
}

function formatCep(cep: string): string {
  const d = cep.replace(/\D/g, "");
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : cep;
}

function formatFone(f: string): string {
  const d = f.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  return f;
}

const BARCODE =
  "repeating-linear-gradient(90deg,#1c1d1b 0 2px,transparent 2px 4px,#1c1d1b 4px 5px,transparent 5px 8px,#1c1d1b 8px 11px,transparent 11px 13px)";

export function DanfeView({ data }: { data: DanfeData }) {
  const nfce = data.modelo === "65";
  const t = data.totais;
  return (
    <div className="overflow-hidden rounded-[10px] border border-(--c-d9d9d4) bg-card text-foreground">
      <Row cols="1.6fr .9fr 1.6fr">
        <Cell label="Emitente">
          <div className="text-[15px] font-semibold">{data.emitente.nome}</div>
          <div className="mt-1 text-[11.5px] leading-[1.5] text-(--c-6b6c66)">
            {address(data.emitente)}
            {data.emitente.fone ? <br /> : null}
            {data.emitente.fone ? `Fone ${formatFone(data.emitente.fone)}` : null}
          </div>
        </Cell>
        <div className="flex flex-col items-center justify-center gap-1 border-r border-(--c-e3e3df) px-3 py-2 text-center">
          <b className="text-xl tracking-[0.08em]">{nfce ? "DANFE NFC-e" : "DANFE"}</b>
          <span className="text-[10.5px] leading-[1.3] text-(--c-6b6c66)">
            Documento Auxiliar da
            <br />
            Nota Fiscal {nfce ? "de Consumidor " : ""}Eletrônica
          </span>
          {nfce ? null : (
            <div className="mt-1 flex items-center gap-2.5">
              <span className="text-[10.5px] leading-[1.3] text-(--c-6b6c66)">
                0 - Entrada
                <br />1 - Saída
              </span>
              <span className="inline-grid h-7 w-[34px] place-items-center rounded border-[1.5px] border-foreground text-base font-bold">
                {data.tipo || "—"}
              </span>
            </div>
          )}
          <div className="mt-1 font-mono text-[12.5px]">
            Nº {formatNoteNumber(data.numero || 0)}
            <br />
            Série {String(data.serie || "0").padStart(3, "0")}
          </div>
        </div>
        <div className="min-w-0 px-3 py-2">
          <div className="mt-1 mb-1 h-11 rounded-[2px]" style={{ background: BARCODE }} aria-hidden />
          <div className="mb-[3px] text-[10px] tracking-[0.06em] text-(--c-6b6c66) uppercase">Chave de acesso</div>
          <div className="font-mono text-xs tracking-[0.02em] break-words">{formatKey(data.chave)}</div>
          <div className="mt-2 mb-[3px] text-[10px] tracking-[0.06em] text-(--c-6b6c66) uppercase">Consulta de autenticidade</div>
          <div className="text-[11.5px] text-(--c-6b6c66)">www.nfe.fazenda.gov.br/portal ou no site da SEFAZ-PI</div>
        </div>
      </Row>
      <Row cols="1.6fr 1.4fr">
        <Cell label="Natureza da operação">{data.natureza}</Cell>
        <Cell label="Protocolo de autorização de uso" mono>
          {data.protocolo}
          {data.protocoloEm ? ` · ${formatDateTime(data.protocoloEm)}` : ""}
        </Cell>
      </Row>
      <Row cols="1fr 1fr 1fr">
        <Cell label="Inscrição estadual" mono>
          {data.emitente.ie}
        </Cell>
        <Cell label="Data da emissão" mono>
          {formatDateTime(data.emissao)}
        </Cell>
        <Cell label="CNPJ / CPF" mono>
          {formatDoc(data.emitente.doc)}
        </Cell>
      </Row>

      <Section>Destinatário / Remetente</Section>
      {data.destinatario ? (
        <>
          <Row cols="2fr 1fr .8fr">
            <Cell label="Nome / Razão social">{data.destinatario.nome}</Cell>
            <Cell label="CNPJ / CPF" mono>
              {formatDoc(data.destinatario.doc)}
            </Cell>
            <Cell label="UF">{data.destinatario.uf}</Cell>
          </Row>
          <Row cols="2fr .8fr 1fr">
            <Cell label="Endereço">{data.destinatario.endereco}</Cell>
            <Cell label="Município">{data.destinatario.municipio}</Cell>
            <Cell label="Inscrição estadual" mono>
              {data.destinatario.ie}
            </Cell>
          </Row>
        </>
      ) : (
        <Row cols="1fr">
          <Cell label="Consumidor">Consumidor não identificado</Cell>
        </Row>
      )}

      <Section>Cálculo do imposto</Section>
      <Row cols="repeat(6, minmax(0, 1fr))">
        <Cell label="Base de cálc. ICMS" mono>{formatMoney(t.baseIcms)}</Cell>
        <Cell label="Valor do ICMS" mono>{formatMoney(t.valorIcms)}</Cell>
        <Cell label="Base ICMS ST" mono>{formatMoney(t.baseIcmsSt)}</Cell>
        <Cell label="Valor ICMS ST" mono>{formatMoney(t.valorIcmsSt)}</Cell>
        <Cell label="Valor dos produtos" mono>{formatMoney(t.valorProdutos)}</Cell>
        <Cell label="Valor total da nota" mono className="bg-(--c-f3faf6) [&>div:last-child]:text-[15px] [&>div:last-child]:font-semibold">
          {formatMoney(t.valorNota)}
        </Cell>
      </Row>
      <Row cols="repeat(6, minmax(0, 1fr))">
        <Cell label="Frete" mono>{formatMoney(t.frete)}</Cell>
        <Cell label="Seguro" mono>{formatMoney(t.seguro)}</Cell>
        <Cell label="Desconto" mono>{formatMoney(t.desconto)}</Cell>
        <Cell label="Outras despesas" mono>{formatMoney(t.outras)}</Cell>
        <Cell label="Valor do IPI" mono>{formatMoney(t.ipi)}</Cell>
        <Cell label="Aprox. tributos (Lei 12.741)" mono>{formatMoney(t.tributos)}</Cell>
      </Row>

      <Section>Dados dos produtos / serviços</Section>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="bg-(--c-fafaf8) text-left text-[10px] tracking-[0.06em] text-(--c-6b6c66) uppercase [&>th]:border-b [&>th]:border-(--c-e3e3df) [&>th]:px-2.5 [&>th]:py-[7px] [&>th]:font-medium">
              <th>Código</th>
              <th>Descrição</th>
              <th>NCM</th>
              <th>CST</th>
              <th>CFOP</th>
              <th>Un</th>
              <th className="text-right">Qtd</th>
              <th className="text-right">V. unit.</th>
              <th className="text-right">V. total</th>
              <th className="text-right">ICMS %</th>
            </tr>
          </thead>
          <tbody>
            {data.itens.map((it, i) => (
              <tr key={`${it.codigo}-${i}`} className="border-b border-(--c-f2f2ef) last:border-b-0 [&>td]:px-2.5 [&>td]:py-2 [&>td]:align-top">
                <td className="font-mono">{it.codigo}</td>
                <td>{it.descricao}</td>
                <td className="font-mono">{it.ncm}</td>
                <td className="font-mono">{it.cst}</td>
                <td className="font-mono">{it.cfop}</td>
                <td>{it.unidade}</td>
                <td className="text-right font-mono">{formatQty(it.quantidade)}</td>
                <td className="text-right font-mono">{formatMoney(it.valorUnitario)}</td>
                <td className="text-right font-mono">{formatMoney(it.valorTotal)}</td>
                <td className="text-right font-mono">{it.aliqIcms ? formatQty(it.aliqIcms) : "—"}</td>
              </tr>
            ))}
            {data.itens.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-2.5 py-3 text-center text-xs text-(--c-6b6c66)">
                  Nenhum item no XML.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {data.transportadora || data.infAdic ? (
        <>
          <Section>Dados adicionais</Section>
          <Row cols="1fr">
            <Cell label="Informações complementares">
              <span className="text-xs leading-[1.5]">
                {data.transportadora ? `Transportadora: ${data.transportadora}. ` : ""}
                {data.infAdic}
              </span>
            </Cell>
          </Row>
        </>
      ) : null}
    </div>
  );
}
