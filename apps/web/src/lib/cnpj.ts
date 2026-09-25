// CNPJ numérico e alfanumérico (IN RFB 2.229/2024). No banco guardamos só
// os 14 caracteres sem pontuação; na tela exibimos 00.000.000/0000-00.

const W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

export function normalizeCNPJ(value: string | null | undefined): string {
  return (value ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

function checkDigit(base: string, weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i += 1) {
    sum += (base.charCodeAt(i) - 48) * weights[i];
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

export function validateCNPJ(value: string | null | undefined): boolean {
  const cnpj = normalizeCNPJ(value);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj)) return false;
  if (/^(.)\1{13}$/.test(cnpj)) return false;
  const d1 = checkDigit(cnpj.slice(0, 12), W1);
  const d2 = checkDigit(cnpj.slice(0, 12) + d1, W2);
  return cnpj.slice(12) === `${d1}${d2}`;
}

export function formatCNPJ(value: string | null | undefined): string {
  const cnpj = normalizeCNPJ(value);
  if (cnpj.length !== 14) return value ?? "";
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}

/** Máscara progressiva para inputs. */
export function maskCNPJ(value: string): string {
  const c = normalizeCNPJ(value).slice(0, 14);
  const parts = [c.slice(0, 2), c.slice(2, 5), c.slice(5, 8), c.slice(8, 12), c.slice(12, 14)];
  let out = parts[0];
  if (parts[1]) out += `.${parts[1]}`;
  if (parts[2]) out += `.${parts[2]}`;
  if (parts[3]) out += `/${parts[3]}`;
  if (parts[4]) out += `-${parts[4]}`;
  return out;
}
