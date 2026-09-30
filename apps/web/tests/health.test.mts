// Saúde da plataforma: semáforo e motivos de cada escritório.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessOrg, hoursLabel, sortByHealth, successRate, type PlatformHealthRow } from "../src/lib/health.ts";

const LIMITS = { offline_hours: 2, outdated_days: 3, failures_day: 5, min_success: 0.8, stuck_hours: 6 };

const row = (over: Partial<PlatformHealthRow> = {}): PlatformHealthRow => ({
  org_id: "a",
  name: "Escritório A",
  status: "active",
  clients: 22,
  max_clients: null,
  latest_version: "1.2.25",
  robots: [{ name: "DESKTOP-74B4DAU", version: "1.2.25", last_seen_at: "2026-09-30T23:00:00Z", online: true, outdated: false }],
  hours_since_signal: "0.1",
  completed_7d: 111,
  failed_7d: 0,
  failed_today: 0,
  stuck: 0,
  waiting_person: 0,
  no_certificate: 0,
  failures_by_code: {},
  certs_expiring: 0,
  certs_expired: 0,
  last_activity: null,
  limits: LIMITS,
  ...over,
});

describe("saúde da plataforma", () => {
  it("tudo funcionando: verde, sem motivos", () => {
    assert.deepEqual(assessOrg(row()), { level: "ok", reasons: [], problems: 0, successRate: 1 });
  });

  it("30/09 à noite: PC do Alex desligado e na versão antiga -> atenção", () => {
    const a = assessOrg(
      row({
        robots: [
          { name: "Alex", version: "1.2.23", last_seen_at: null, online: false, outdated: true },
          { name: "DESKTOP-74B4DAU", version: "1.2.25", last_seen_at: null, online: false, outdated: false },
        ],
        hours_since_signal: "2.7",
      }),
    );
    assert.equal(a.level, "attention");
    assert.deepEqual(a.reasons, ["nenhum robô ligado há 2,7 h", "Alex (1.2.23) desatualizado; a mais nova é 1.2.25"]);
  });

  it("30/09 às 16h: falhas e trabalhos parados -> problema, e os problemas vêm primeiro", () => {
    const a = assessOrg(row({ failed_today: 5, stuck: 4, certs_expiring: 1 }));
    assert.equal(a.level, "problem");
    assert.equal(a.problems, 2);
    assert.deepEqual(a.reasons, [
      "5 falha(s) hoje",
      "4 aguardando a SEFAZ há mais de 6 h",
      "1 certificado(s) vencendo em 30 dias",
    ]);
  });

  it("taxa de sucesso baixa só conta com 10+ trabalhos na semana", () => {
    assert.equal(assessOrg(row({ completed_7d: 6, failed_7d: 4 })).level, "problem");
    assert.equal(assessOrg(row({ completed_7d: 2, failed_7d: 3 })).level, "ok");
    assert.equal(successRate({ completed_7d: 0, failed_7d: 0 }), null);
  });

  it("sem computador ou suspenso: cinza", () => {
    assert.deepEqual(assessOrg(row({ robots: [], hours_since_signal: null })).reasons, ["Nenhum computador ativado"]);
    assert.equal(assessOrg(row({ status: "suspended" })).level, "idle");
  });

  it("ordena problemas primeiro", () => {
    const sorted = sortByHealth([
      row({ org_id: "1", name: "Teste", robots: [] }),
      row({ org_id: "2", name: "Bom" }),
      row({ org_id: "3", name: "Ruim", failed_today: 9 }),
    ]);
    assert.deepEqual(
      sorted.map((r) => [r.name, r.health.level]),
      [
        ["Ruim", "problem"],
        ["Bom", "ok"],
        ["Teste", "idle"],
      ],
    );
  });

  it("horas em texto", () => {
    assert.equal(hoursLabel(0.4), "24 min");
    assert.equal(hoursLabel(2.7), "2,7 h");
    assert.equal(hoursLabel(50), "2 dias");
  });
});
