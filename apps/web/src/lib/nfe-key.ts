// Chave de acesso da NF-e/NFC-e (44 dígitos): validação e as partes que ela carrega.
//
//   22 2609 12345678000190 55 001 000012345 1 12345678 9
//   UF ano/mês CNPJ emitente mod série número tpEmis cNF DV

export interface KeyParts {
  uf: string;
  /** "09/2026" */
  anoMes: string;
  cnpjEmitente: string;
  /** 55 = NF-e, 65 = NFC-e */
  modelo: string;
  serie: number;
  numero: number;
}

export function keyDigits(input: string): string {
  return input.replace(/\D/g, "");
}

/** Dígito verificador (módulo 11) dos 43 primeiros dígitos. */
export function keyCheckDigit(first43: string): number {
  let weight = 2;
  let sum = 0;
  for (let i = first43.length - 1; i >= 0; i -= 1) {
    sum += Number(first43[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

export function isValidKey(input: string): boolean {
  const k = keyDigits(input);
  return k.length === 44 && keyCheckDigit(k.slice(0, 43)) === Number(k[43]);
}

export function keyParts(input: string): KeyParts | null {
  const k = keyDigits(input);
  if (k.length !== 44) return null;
  return {
    uf: k.slice(0, 2),
    anoMes: `${k.slice(4, 6)}/20${k.slice(2, 4)}`,
    cnpjEmitente: k.slice(6, 20),
    modelo: k.slice(20, 22),
    serie: Number(k.slice(22, 25)),
    numero: Number(k.slice(25, 34)),
  };
}

/** "2226 0837 3548 ..." (grupos de 4, como na DANFE). */
export function formatKey(input: string): string {
  return keyDigits(input).replace(/(\d{4})(?=\d)/g, "$1 ");
}

/** O que a pessoa digitou na busca: chave, número da nota, CNPJ/CPF ou um nome. */
export type NoteQuery =
  | { kind: "chave"; value: string }
  | { kind: "numero"; value: number }
  | { kind: "documento"; value: string }
  | { kind: "nome"; value: string }
  | null;

export function parseNoteQuery(raw: string): NoteQuery {
  const q = raw.trim();
  if (!q) return null;
  const digits = keyDigits(q);
  const onlyDigitsAndMarks = /^[\d.\-/\s]+$/.test(q);
  // 44 números: NF-e/NFC-e; 50: NFS-e Nacional
  if (onlyDigitsAndMarks && (digits.length === 44 || digits.length === 50)) return { kind: "chave", value: digits };
  if (onlyDigitsAndMarks && (digits.length === 14 || digits.length === 11)) return { kind: "documento", value: digits };
  if (onlyDigitsAndMarks && digits.length > 0 && digits.length <= 9) return { kind: "numero", value: Number(digits) };
  // nomes: sem os caracteres que o filtro do banco usa como separador
  return { kind: "nome", value: q.replace(/[,()%]/g, " ").replace(/\s+/g, " ").trim() };
}
