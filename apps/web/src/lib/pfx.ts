// Leitura de certificado A1 (.pfx/.p12) no PRÓPRIO navegador: o arquivo e a
// senha nunca saem do computador do usuário (não passam pelo servidor nem pela API).
import forge from "node-forge";

import { normalizeCNPJ, validateCNPJ } from "./cnpj.ts";

export interface PfxInfo {
  subject_name: string;
  common_name: string;
  issuer: string;
  issuer_common_name: string;
  serial_number: string;
  thumbprint: string;
  valid_from: string;
  valid_until: string;
  cnpj: string | null;
}

export class PfxError extends Error {}

// ICP-Brasil: CNPJ do titular no SubjectAltName (otherName)
const OID_ICP_CNPJ = "2.16.76.1.3.3";

function attr(cert: forge.pki.Certificate, field: "subject" | "issuer", short: string): string {
  const a = cert[field].getField(short);
  return a ? String(a.value) : "";
}

function dn(cert: forge.pki.Certificate, field: "subject" | "issuer"): string {
  return cert[field].attributes
    .filter((a) => a.shortName)
    .map((a) => `${a.shortName}=${a.value}`)
    .reverse()
    .join(", ");
}

function icpCnpj(cert: forge.pki.Certificate): string | null {
  const raw = cert.extensions.find((e) => e.name === "subjectAltName") as { value?: string } | undefined;
  // node-forge não decodifica otherName: procura o OID dentro do valor DER bruto
  const der = raw?.value;
  if (der) {
    try {
      const asn1 = forge.asn1.fromDer(der);
      for (const name of asn1.value as forge.asn1.Asn1[]) {
        // otherName = [0] { type-id OID, [0] EXPLICIT value }
        if (name.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || name.type !== 0) continue;
        const parts = name.value as forge.asn1.Asn1[];
        const oid = forge.asn1.derToOid(parts[0].value as string);
        if (oid !== OID_ICP_CNPJ) continue;
        const inner = (parts[1].value as forge.asn1.Asn1[])[0];
        const cnpj = normalizeCNPJ(String(inner.value));
        if (validateCNPJ(cnpj)) return cnpj;
      }
    } catch {
      // SAN em formato inesperado: cai para o CNPJ no nome
    }
  }
  return null;
}

function cnpjFromName(name: string): string | null {
  const m = /(\d{14})\s*$/.exec(name.replace(/[^\d:\s]/g, " ").trim());
  return m && validateCNPJ(m[1]) ? m[1] : null;
}

/** Escolhe o certificado do titular (o que não é emissor de nenhum outro da cadeia). */
function leafCertificate(certs: forge.pki.Certificate[]): forge.pki.Certificate {
  if (certs.length === 1) return certs[0];
  const issuers = new Set(certs.map((c) => c.issuer.hash));
  return certs.find((c) => !issuers.has(c.subject.hash)) ?? certs[0];
}

export function parsePfx(data: ArrayBuffer | Uint8Array, password: string): PfxInfo {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length === 0) throw new PfxError("Arquivo vazio.");

  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.binary.raw.encode(bytes));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password|mac|invalid|decrypt/i.test(msg)) {
      throw new PfxError("Senha incorreta ou arquivo de certificado inválido.");
    }
    throw new PfxError(`Não foi possível ler o certificado: ${msg}`);
  }

  const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const certs = bags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => Boolean(c));
  if (certs.length === 0) throw new PfxError("O arquivo não contém certificado.");
  const cert = leafCertificate(certs);

  const cn = attr(cert, "subject", "CN") || dn(cert, "subject");
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const thumbprint = forge.md.sha1.create().update(der).digest().toHex().toUpperCase();

  return {
    subject_name: cn,
    common_name: cn,
    issuer: dn(cert, "issuer"),
    issuer_common_name: attr(cert, "issuer", "CN"),
    serial_number: cert.serialNumber.replace(/^0+(?=.)/, "").toUpperCase(),
    thumbprint,
    valid_from: cert.validity.notBefore.toISOString(),
    valid_until: cert.validity.notAfter.toISOString(),
    cnpj: icpCnpj(cert) ?? cnpjFromName(cn),
  };
}
