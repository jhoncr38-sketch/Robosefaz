import "server-only";

/** Nome e cidade de um CNPJ na base pública da Receita (BrasilAPI). Sem resposta em 4 s: null. */
export async function lookupCnpj(cnpj: string): Promise<{ nome: string; cidade: string } | null> {
  const d = cnpj.replace(/\D/g, "");
  if (d.length !== 14) return null;
  try {
    const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${d}`, {
      signal: AbortSignal.timeout(4000),
      next: { revalidate: 86_400 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { razao_social?: string; nome_fantasia?: string; municipio?: string; uf?: string };
    const nome = data.nome_fantasia || data.razao_social;
    if (!nome) return null;
    return { nome, cidade: [data.municipio, data.uf].filter(Boolean).join("/") };
  } catch {
    return null;
  }
}
