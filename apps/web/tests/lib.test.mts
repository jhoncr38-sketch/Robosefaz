// Testes das regras compartilhadas do painel: `npm test` (node --test, sem dependências extras).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatCNPJ, maskCNPJ, normalizeCNPJ, validateCNPJ } from "../src/lib/cnpj.ts";
import {
  competenceBounds,
  formatCompetence,
  previousCompetence,
  recentCompetences,
  toCompetenceKey,
} from "../src/lib/competence.ts";
import { can } from "../src/lib/permissions.ts";

describe("CNPJ", () => {
  it("valida numérico e alfanumérico", () => {
    assert.equal(validateCNPJ("11.222.333/0001-81"), true);
    assert.equal(validateCNPJ("11222333000182"), false);
    assert.equal(validateCNPJ("00000000000000"), false);
    assert.equal(validateCNPJ("12.ABC.345/01DE-35"), true);
    assert.equal(validateCNPJ(""), false);
  });
  it("normaliza, formata e aplica máscara", () => {
    assert.equal(normalizeCNPJ("11.222.333/0001-81"), "11222333000181");
    assert.equal(formatCNPJ("11222333000181"), "11.222.333/0001-81");
    assert.equal(maskCNPJ("112223"), "11.222.3");
    assert.equal(maskCNPJ("11222333000181999"), "11.222.333/0001-81");
  });
});

describe("Competência", () => {
  it("converte formatos", () => {
    assert.equal(toCompetenceKey("08/2026"), "2026-08");
    assert.equal(toCompetenceKey("2026-08"), "2026-08");
    assert.equal(toCompetenceKey("13/2026"), null);
    assert.equal(formatCompetence("2026-08"), "08/2026");
  });
  it("gera o período do mês", () => {
    assert.deepEqual(competenceBounds("08/2026"), { start: "01/08/2026", end: "31/08/2026" });
    assert.deepEqual(competenceBounds("2024-02"), { start: "01/02/2024", end: "29/02/2024" });
  });
  it("lista competências recentes", () => {
    const now = new Date(2026, 0, 15);
    assert.equal(previousCompetence(now), "2025-12");
    assert.deepEqual(recentCompetences(3, now), ["2026-01", "2025-12", "2025-11"]);
  });
});

describe("Permissões", () => {
  it("respeita os papéis", () => {
    assert.equal(can("admin", "automation:retry"), true);
    assert.equal(can("operator", "automation:run"), true);
    assert.equal(can("operator", "automation:retry"), false);
    assert.equal(can("operator", "clients:write"), false);
    assert.equal(can("viewer", "automation:run"), false);
    assert.equal(can(null, "automation:run"), false);
  });
});
