// Listas da tela Emitir NFS-e: código nacional, NBS, indicador da operação e classificação tributária,
// tiradas das tabelas oficiais da NFS-e nacional (Anexos VII e VIII).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as tables from "../src/lib/nfse-tabelas-data.ts";
import {
  classTribOptions,
  correlationRows,
  cstLabel,
  cstOf,
  defaultIbs,
  fillIbs,
  filterOptions,
  formatNac,
  GROUP_OTHERS,
  GROUP_SUGGESTED,
  indOpOptions,
  nationalOptions,
  nbsOptions,
  onlyIndOp,
  withCurrent,
} from "../src/lib/nfse-tabelas.ts";

const suggested = (options: { value: string; group?: string }[]) => options.filter((o) => o.group === GROUP_SUGGESTED).map((o) => o.value);

describe("tabelas oficiais da NFS-e", () => {
  it("traz a lista nacional inteira, com o código formatado", () => {
    const all = nationalOptions(tables);
    assert.equal(all.length, 335);
    assert.equal(formatNac("140601"), "14.06.01");
    assert.match(all.find((o) => o.value === "140601")!.label, /^14\.06\.01 - Instalação e montagem de aparelhos/);
  });

  it("todo código nacional tem linha na correlação, pelos 6 números ou pelo item", () => {
    for (const code of Object.keys(tables.TRIB_NACIONAL)) assert.ok(correlationRows(tables, code).length, code);
    assert.ok(tables.CORRELACAO["990101"], "o grupo 99 é ligado pelos 6 números");
    assert.equal(correlationRows(tables, "140601"), tables.CORRELACAO["1406"]);
  });

  it("14.06.01: os NBS, o indicador e a classificação que a prefeitura mostra", () => {
    const nbs = nbsOptions(tables, "140601");
    for (const code of ["101066000", "120032520", "120032610", "101061300", "120031000", "120032400", "101061200", "101061400"]) {
      assert.ok(nbs.some((o) => o.value === code), code);
    }
    assert.equal(nbs.find((o) => o.value === "101066000")!.label, "1.0106.60.00 - Serviços de instalação de elevadores, esteiras e escadas rolantes");
    assert.deepEqual(suggested(classTribOptions(tables, "140601", "101066000")), ["000001"]);
    assert.deepEqual(suggested(indOpOptions(tables, "140601", "101066000")), ["050101", "050102"]);
    assert.equal(onlyIndOp(tables, "140601", "101066000"), "", "com duas opções, quem escolhe é a pessoa");
  });

  it("a classificação indicada muda com o NBS escolhido", () => {
    assert.deepEqual(suggested(classTribOptions(tables, "010101", "115021000")), ["000001"]);
    assert.deepEqual(suggested(classTribOptions(tables, "010101", "115029000")), ["000001", "200043", "200044"]);
    // sem NBS (ou com NBS fora da tabela), valem as do item inteiro
    assert.deepEqual(suggested(classTribOptions(tables, "010101", "")), ["000001", "200043", "200044"]);
    assert.deepEqual(suggested(classTribOptions(tables, "010101", "999999999")), ["000001", "200043", "200044"]);
  });

  it("IBS/CBS que a tabela resolve sozinha: a classificação quando só há uma; o indicador, quando também é único", () => {
    // 14.13.01: uma classificação e dois indicadores -> a classificação vem, o indicador fica para a pessoa
    assert.deepEqual(defaultIbs(tables, "141301", "101075000"), { classTrib: "000001", cst: "000", indOp: "" });
    // 10.02.01: uma classificação e um indicador -> vem tudo
    assert.deepEqual(defaultIbs(tables, "100201", ""), { classTrib: "000001", cst: "000", indOp: "100301" });
    // 01.01.01: depende do NBS; sem ele há mais de uma classificação possível e nada é escolhido
    assert.equal(defaultIbs(tables, "010101", "115021000")?.classTrib, "000001");
    assert.equal(defaultIbs(tables, "010101", ""), null);
    assert.equal(defaultIbs(tables, "010101", "115029000"), null);
    // serviço fora da tabela
    assert.equal(defaultIbs(tables, "999999", ""), null);
  });

  it("o rascunho sem IBS/CBS recebe o da tabela; o que veio de uma nota, o digitado e o 'não informar' ficam", () => {
    const empty = { nbs: "101075000", cst: "", classTrib: "", indOp: "", typed: false, ibsAuto: false, ibsOff: false };
    assert.deepEqual(fillIbs(empty, tables, "141301"), { ...empty, classTrib: "000001", cst: "000", indOp: "", ibsAuto: true });
    assert.deepEqual(fillIbs({ ...empty, nbs: "" }, tables, "100201"), { ...empty, nbs: "", classTrib: "000001", cst: "000", indOp: "100301", ibsAuto: true });
    // copiado da última nota: fica como está, mesmo diferente do que a tabela indica
    const copied = { ...empty, cst: "200", classTrib: "200043", indOp: "050102" };
    assert.equal(fillIbs(copied, tables, "141301"), copied);
    // quem escolheu não informar, quem está digitando os códigos e serviço sem resposta única: nada é preenchido
    for (const kept of [{ ...empty, ibsOff: true }, { ...empty, typed: true }]) assert.equal(fillIbs(kept, tables, "141301"), kept);
    const open = { ...empty, nbs: "" };
    assert.equal(fillIbs(open, tables, "010101"), open);
    assert.equal(fillIbs(open, tables, ""), open);
    // as listas ainda não chegaram: espera
    assert.equal(fillIbs(empty, null, "141301"), empty);
  });

  it("as demais opções continuam disponíveis, depois das indicadas", () => {
    const options = classTribOptions(tables, "100901", "102010000");
    assert.deepEqual(suggested(options), ["000001"]);
    const other = options.find((o) => o.value === "200052")!;
    assert.equal(other.group, GROUP_OTHERS);
    assert.match(other.label, /^200052 - Prestação de serviços de profissões intelectuais/);
    assert.equal(onlyIndOp(tables, "100901", "102010000"), "100301");
    const ind = indOpOptions(tables, "100901", "102010000");
    assert.equal(ind[0].value, "100301");
    assert.match(ind[0].hint ?? "", /Endereço do Tomador/);
    assert.equal(new Set(ind.map((o) => o.value)).size, ind.length, "sem indicador repetido");
  });

  it("a situação tributária sai da classificação", () => {
    assert.equal(cstOf("200052"), "200");
    assert.equal(cstOf("2000"), "");
    assert.equal(cstLabel(tables, "000"), "000 - Tributação integral");
    assert.equal(cstLabel(tables, "999"), "999");
    assert.equal(cstLabel(null, "200"), "200");
    for (const code of Object.keys(tables.CLASS_TRIB)) assert.ok(tables.CST[cstOf(code)], `CST de ${code}`);
  });

  it("todo NBS e toda classificação da correlação têm nome", () => {
    for (const rows of Object.values(tables.CORRELACAO)) {
      for (const [nbs, , classes] of rows) {
        if (nbs) assert.ok(tables.NBS_NOMES[nbs], nbs);
        for (const c of classes) assert.ok(tables.CLASS_TRIB[c], c);
      }
    }
  });

  it("a busca aceita número com ou sem pontos e palavras sem acento", () => {
    const all = nationalOptions(tables);
    assert.deepEqual(filterOptions(all, "1406").map((o) => o.value), ["140601"]);
    assert.deepEqual(filterOptions(all, "14.06").map((o) => o.value), ["140601"]);
    assert.ok(filterOptions(all, "instalacao montagem").some((o) => o.value === "140601"));
    assert.equal(filterOptions(all, "  ").length, all.length);
    assert.equal(filterOptions(all, "zzzz").length, 0);
    assert.deepEqual(filterOptions(nbsOptions(tables, "140601"), "elevadores").map((o) => o.value), ["101066000"]);
  });

  it("um valor fora da lista (da última nota) continua aparecendo", () => {
    const options = nbsOptions(tables, "140601");
    assert.equal(withCurrent(options, "101066000", "x").length, options.length);
    assert.equal(withCurrent(options, "", "x").length, options.length);
    const kept = withCurrent(options, "999999999", "9.9999.99.99 (da última nota)");
    assert.equal(kept.length, options.length + 1);
    assert.equal(kept[0].value, "999999999");
  });
});
