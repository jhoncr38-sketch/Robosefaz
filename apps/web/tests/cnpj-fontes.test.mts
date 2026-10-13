// Consulta pública de CNPJ (tomador novo): leitura dos formatos das três fontes. Dados fictícios.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CNPJ_SOURCES, fromBrasilApi, fromCnpjWs, usableRecord } from "../src/lib/cnpj-fontes.ts";

describe("consulta pública de CNPJ", () => {
  it("lê o formato da BrasilAPI e do minhareceita.org", () => {
    const r = fromBrasilApi({
      razao_social: "EMPRESA EXEMPLO LTDA", codigo_municipio_ibge: 2211001, municipio: "TERESINA", uf: "PI", cep: "64000-100",
      descricao_tipo_de_logradouro: "RUA", logradouro: "DAS FLORES", numero: "", complemento: "SALA 2", bairro: "CENTRO", descricao_situacao_cadastral: "ATIVA",
    });
    assert.deepEqual(r, {
      nome: "EMPRESA EXEMPLO LTDA", cmun: "2211001", cidade: "TERESINA/PI", cep: "64000100", logradouro: "RUA DAS FLORES", numero: "S/N",
      complemento: "SALA 2", bairro: "CENTRO", situacao: "ATIVA",
    });
    assert.equal(usableRecord(r), true);
  });

  it("lê o formato do publica.cnpj.ws (estabelecimento aninhado)", () => {
    const r = fromCnpjWs({
      razao_social: "EMPRESA EXEMPLO LTDA",
      estabelecimento: {
        cep: "64000100", tipo_logradouro: "AVENIDA", logradouro: "PRINCIPAL", numero: "100", complemento: "", bairro: "CENTRO", situacao_cadastral: "Ativa",
        cidade: { ibge_id: 2211001, nome: "Teresina" }, estado: { sigla: "PI" },
      },
    });
    assert.deepEqual(r, {
      nome: "EMPRESA EXEMPLO LTDA", cmun: "2211001", cidade: "Teresina/PI", cep: "64000100", logradouro: "AVENIDA PRINCIPAL", numero: "100",
      complemento: "", bairro: "CENTRO", situacao: "Ativa",
    });
    assert.equal(usableRecord(r), true);
  });

  it("registro sem nome ou sem município não serve; as três fontes têm endereço próprio", () => {
    assert.equal(usableRecord(fromBrasilApi({ razao_social: "X" })), false);
    assert.equal(usableRecord(fromCnpjWs({ estabelecimento: { cidade: { ibge_id: 2211001 } } })), false);
    assert.deepEqual(CNPJ_SOURCES.map((s) => s.name), ["BrasilAPI", "minhareceita.org", "publica.cnpj.ws"]);
    assert.ok(CNPJ_SOURCES.every((s) => s.url("11222333000181").endsWith("11222333000181")));
  });
});
