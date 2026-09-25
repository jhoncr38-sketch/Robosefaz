// Leitura de PFX no navegador (node-forge). Certificados de TESTE, falsos, gerados
// para estes testes (CN "EMPRESA TESTE LTDA:11222333000181", senha 1234).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parsePfx, PfxError } from "../src/lib/pfx.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

for (const file of ["a1-aes.pfx", "a1-legacy-3des.pfx"]) {
  describe(`PFX ${file}`, () => {
    it("lê titular, emissor, série, thumbprint, validade e CNPJ ICP-Brasil", () => {
      const info = parsePfx(fixture(file), "1234");
      assert.equal(info.subject_name, "EMPRESA TESTE LTDA:11222333000181");
      assert.equal(info.issuer_common_name, "AC TESTE RFB v5");
      assert.match(info.issuer, /CN=AC TESTE RFB v5/);
      assert.equal(info.serial_number, "ABC123");
      assert.equal(info.thumbprint, "C6800C33B20285B5C87156A7342A058C803F9FA3");
      assert.equal(info.valid_from, "2026-01-01T00:00:00.000Z");
      assert.equal(info.valid_until, "2027-01-01T00:00:00.000Z");
      assert.equal(info.cnpj, "11222333000181");
    });

    it("escolhe o certificado do titular, não o da AC da cadeia", () => {
      assert.notEqual(parsePfx(fixture(file), "1234").subject_name, "AC TESTE RFB v5");
    });

    it("rejeita senha errada", () => {
      assert.throws(() => parsePfx(fixture(file), "errada"), PfxError);
    });
  });
}

describe("PFX inválido", () => {
  it("rejeita arquivo vazio ou que não é certificado", () => {
    assert.throws(() => parsePfx(new Uint8Array(), "1234"), /vazio/);
    assert.throws(() => parsePfx(new TextEncoder().encode("não é um pfx"), "1234"), PfxError);
  });
});
