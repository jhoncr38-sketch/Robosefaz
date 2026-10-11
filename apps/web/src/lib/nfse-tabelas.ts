// Listas da tela Emitir NFS-e (código nacional, NBS, indicador da operação, classificação tributária),
// montadas das tabelas oficiais da NFS-e nacional. Os dados ficam em nfse-tabelas-data.ts, que a tela
// carrega só quando abre um rascunho; por isso as funções recebem as tabelas.
import { formatNbs } from "./nfse-emit.ts";

export interface NfseTables {
  TRIB_NACIONAL: Record<string, string>;
  CORRELACAO: Record<string, [string, string[], string[]][]>;
  NBS_NOMES: Record<string, string>;
  IND_OP: Record<string, [string, string, string]>;
  CLASS_TRIB: Record<string, string>;
  CST: Record<string, string>;
}

export interface CodeOption {
  value: string;
  label: string;
  /** linha menor, abaixo do rótulo */
  hint?: string;
  group?: string;
}

export const GROUP_SUGGESTED = "Indicados para este serviço";
export const GROUP_OTHERS = "Outros";

/** "140601" -> "14.06.01" */
export function formatNac(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 2)}.${code.slice(2, 4)}.${code.slice(4)}` : code;
}

/** Linhas da correlação do código nacional: pelos 6 números quando o código tem linha própria; senão, pelo item (4). */
export function correlationRows(t: NfseTables, nac: string): [string, string[], string[]][] {
  return t.CORRELACAO[nac] ?? t.CORRELACAO[nac.slice(0, 4)] ?? [];
}

export function nationalOptions(t: NfseTables): CodeOption[] {
  return Object.entries(t.TRIB_NACIONAL).map(([code, name]) => ({ value: code, label: `${formatNac(code)} - ${name}` }));
}

export function nbsLabel(t: NfseTables, nbs: string): string {
  return [formatNbs(nbs), t.NBS_NOMES[nbs]].filter(Boolean).join(" - ");
}

/** NBS que a tabela oficial liga ao código nacional. */
export function nbsOptions(t: NfseTables, nac: string): CodeOption[] {
  const codes = [...new Set(correlationRows(t, nac).map((r) => r[0]).filter(Boolean))].sort();
  return codes.map((nbs) => ({ value: nbs, label: nbsLabel(t, nbs) }));
}

/** Códigos que a tabela indica para o serviço: os do NBS escolhido; sem NBS (ou com NBS fora da tabela), os de todo o item. */
function suggested(t: NfseTables, nac: string, nbs: string, column: 1 | 2): string[] {
  const rows = correlationRows(t, nac);
  const own = nbs ? rows.filter((r) => r[0] === nbs) : [];
  return [...new Set((own.length ? own : rows).flatMap((r) => r[column]))].sort();
}

export function indOpLabel(t: NfseTables, code: string): string {
  return [code, t.IND_OP[code]?.[0]].filter(Boolean).join(" - ");
}

/** Indicadores da operação: primeiro os que a tabela liga ao serviço, depois os demais aceitos na NFS-e. */
export function indOpOptions(t: NfseTables, nac: string, nbs: string): CodeOption[] {
  const first = suggested(t, nac, nbs, 1);
  const hint = (code: string) => {
    const [, detail, place] = t.IND_OP[code] ?? ["", "", ""];
    return [place ? `IBS no local: ${place}` : "", detail].filter(Boolean).join(" · ") || undefined;
  };
  const option = (code: string, group: string): CodeOption => ({ value: code, label: indOpLabel(t, code), hint: hint(code), group });
  const rest = Object.keys(t.IND_OP).filter((code) => !first.includes(code)).sort();
  return [...first.map((c) => option(c, GROUP_SUGGESTED)), ...rest.map((c) => option(c, GROUP_OTHERS))];
}

export function classTribLabel(t: NfseTables, code: string): string {
  return [code, t.CLASS_TRIB[code]].filter(Boolean).join(" - ");
}

/** Classificações tributárias: primeiro as que a tabela liga ao serviço, depois as demais da tabela. */
export function classTribOptions(t: NfseTables, nac: string, nbs: string): CodeOption[] {
  const first = suggested(t, nac, nbs, 2);
  const rest = Object.keys(t.CLASS_TRIB).filter((code) => !first.includes(code)).sort();
  return [
    ...first.map((code) => ({ value: code, label: classTribLabel(t, code), group: GROUP_SUGGESTED })),
    ...rest.map((code) => ({ value: code, label: classTribLabel(t, code), group: GROUP_OTHERS })),
  ];
}

/** A situação tributária (CST) são os três primeiros números da classificação. */
export function cstOf(classTrib: string): string {
  return /^\d{6}$/.test(classTrib) ? classTrib.slice(0, 3) : "";
}

export function cstLabel(t: NfseTables | null, cst: string): string {
  return [cst, t?.CST[cst]].filter(Boolean).join(" - ");
}

/** O indicador quando a tabela só dá uma opção para o serviço (senão, quem escolhe é a pessoa). */
export function onlyIndOp(t: NfseTables, nac: string, nbs: string): string {
  const first = suggested(t, nac, nbs, 1);
  return first.length === 1 ? first[0] : "";
}

/** Mantém na lista um valor que não está nela (ex.: copiado da última nota), para a tela não escondê-lo. */
export function withCurrent(options: CodeOption[], value: string, label: string): CodeOption[] {
  return !value || options.some((o) => o.value === value) ? options : [{ value, label, group: options[0]?.group ? "Da última nota" : undefined }, ...options];
}

const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Filtro da busca: todas as palavras digitadas, sem acento; números valem com ou sem pontos ("1406" acha "14.06.01"). */
export function filterOptions(options: CodeOption[], query: string): CodeOption[] {
  const words = plain(query).split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((o) => {
    const text = plain(`${o.label} ${o.hint ?? ""}`);
    const compact = `${o.value} ${text.replace(/[.\s/-]/g, "")}`;
    return words.every((w) => text.includes(w) || (/^[\d.]+$/.test(w) && compact.includes(w.replace(/\./g, ""))));
  });
}
