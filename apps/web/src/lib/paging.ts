// "Carregar mais" das listas longas (Downloads, Histórico): a URL guarda quantas linhas mostrar
// (?mostrar=1000) e cada clique soma um lote. Trocar um filtro volta ao primeiro lote.

export const SHOW_PARAM = "mostrar";
/** teto de segurança: a página nunca busca mais que isso de uma vez */
export const SHOW_MAX = 10_000;

/** Quantas linhas mostrar: múltiplo do lote, entre um lote e o teto. */
export function parseShown(value: unknown, page: number): number {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(n) || n <= page) return page;
  return Math.min(Math.ceil(n / page) * page, SHOW_MAX);
}

/** Link do "Carregar mais": os mesmos filtros, com mais um lote. */
export function moreHref(path: string, params: Record<string, string | string[] | undefined>, shown: number, page: number): string {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string"));
  q.set(SHOW_PARAM, String(Math.min(shown + page, SHOW_MAX)));
  return `${path}?${q}`;
}

/** Os `n` mais recentes de duas listas já em ordem (mais novo primeiro), sem perder a ordem. */
export function newest<A, B>(a: A[], b: B[], dateA: (x: A) => string, dateB: (x: B) => string, n: number): { a: A[]; b: B[] } {
  const out: { a: A[]; b: B[] } = { a: [], b: [] };
  let i = 0;
  let j = 0;
  while (out.a.length + out.b.length < n && (i < a.length || j < b.length)) {
    if (j >= b.length || (i < a.length && dateA(a[i]) >= dateB(b[j]))) out.a.push(a[i++]);
    else out.b.push(b[j++]);
  }
  return out;
}
