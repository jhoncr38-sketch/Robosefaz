// Consulta de Malhas: situação de cada cliente e formatação.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareMalhaRows, findingsSummary, formatBRL, malhaRowState, malhasLabel, type MalhaCheckJob } from "../src/lib/malhas.ts";
import type { MalhaCheck } from "../src/lib/types.ts";

const check = (total: number, checked_at = "2026-09-29T20:00:00Z"): MalhaCheck => ({
  id: "c",
  client_id: "x",
  job_id: null,
  state_registration: "197381820",
  legal_name: "CONSULT RL",
  findings: [],
  total,
  icms_total: total ? 110.07 : 0,
  nfe_total: total ? 13 : 0,
  raw_text: null,
  checked_at,
});
const job = (status: MalhaCheckJob["status"], created_at: string): MalhaCheckJob => ({
  id: "j",
  client_id: "x",
  status,
  created_at,
  last_message: null,
  error_message: null,
});

describe("situação das malhas", () => {
  it("consulta em andamento vem primeiro", () => {
    assert.equal(malhaRowState(check(1), [job("queued", "2026-09-29T21:00:00Z")]), "checking");
  });
  it("leitura com ou sem malha", () => {
    assert.equal(malhaRowState(check(0), []), "clean");
    assert.equal(malhaRowState(check(2), [job("completed", "2026-09-29T19:00:00Z")]), "findings");
  });
  it("erro depois da última leitura; leitura mais nova que o erro vale", () => {
    assert.equal(malhaRowState(null, [job("failed", "2026-09-29T21:00:00Z")]), "check_failed");
    assert.equal(malhaRowState(check(0, "2026-09-29T20:00:00Z"), [job("failed", "2026-09-29T21:00:00Z")]), "check_failed");
    assert.equal(malhaRowState(check(0, "2026-09-29T22:00:00Z"), [job("failed", "2026-09-29T21:00:00Z")]), "clean");
    assert.equal(malhaRowState(null, []), "not_checked");
  });
  it("formatação", () => {
    assert.equal(formatBRL(110.07).replace(/ /g, " "), "R$ 110,07");
    assert.equal(formatBRL("1234.5").replace(/ /g, " "), "R$ 1.234,50");
    assert.equal(formatBRL(null), "—");
    assert.equal(malhasLabel(1), "1 malha");
    assert.equal(malhasLabel(3), "3 malhas");
  });
});

describe("Malhas no refino: ordem e resumo", () => {
  it("com malha (maior ICMS primeiro), erro, não consultado, consultando, sem malha", () => {
    const rows = [
      { state: "clean" as const, icms: 0, name: "A" },
      { state: "findings" as const, icms: 100, name: "B" },
      { state: "not_checked" as const, icms: 0, name: "C" },
      { state: "findings" as const, icms: 900, name: "D" },
      { state: "check_failed" as const, icms: 0, name: "E" },
      { state: "checking" as const, icms: 0, name: "F" },
    ];
    assert.deepEqual([...rows].sort(compareMalhaRows).map((r) => r.name), ["D", "B", "E", "C", "F", "A"]);
  });

  it("primeira malha e quantas mais", () => {
    const f = (identification: string) => ({ source: "EFD_OIE" as const, identification, periods: null, icms: null, nfe_count: null });
    assert.equal(findingsSummary({ total: 2, findings: [f("Omissão de entradas NF-e"), f("Outra")] }), "2 malhas · Omissão de entradas NF-e e mais 1");
    assert.equal(findingsSummary({ total: 1, findings: [f("ICMS destacado e não escriturado")] }), "1 malha · ICMS destacado e não escriturado");
  });
});
