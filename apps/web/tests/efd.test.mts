// Consulta EFD: situação de cada cliente na competência.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EFD_SEVERITY,
  efdHint,
  efdRowState,
  efdTab,
  isProblem,
  latestDeclaration,
  stillValidAfterRejectedRetif,
  type EfdCheckJob,
} from "../src/lib/efd.ts";
import type { EfdDeclaration } from "../src/lib/types.ts";

function decl(epe: string, situation: EfdDeclaration["situation"], processedAt: string, finalidade = "ORIGINAL"): EfdDeclaration {
  return {
    id: epe,
    client_id: "c1",
    job_id: null,
    competence: "2026-07",
    epe_number: epe,
    finalidade,
    processed: situation !== "not_processed",
    situation,
    processed_at: processedAt,
    received_at: null,
    message_sent_at: null,
    subject: null,
    inconsistencies: [],
    raw_text: null,
    checked_at: "2026-09-27T00:00:00Z",
  };
}

function job(status: EfdCheckJob["status"], created: string): EfdCheckJob {
  return { id: created, client_id: "c1", status, created_at: created, last_message: null, error_message: null };
}

describe("Consulta EFD", () => {
  const original = decl("93104780277", "not_processed", "2026-08-10T18:20:49Z");
  const retificadora = decl("93104801993", "processed", "2026-08-12T18:29:39Z", "RETIFICADORA");

  it("vale a declaração processada por último (retificadora substitui a original)", () => {
    assert.equal(latestDeclaration([original, retificadora])?.epe_number, "93104801993");
    assert.equal(efdRowState([original, retificadora], [job("completed", "2026-09-27T01:00:00Z")]), "processed");
  });

  it("consulta em andamento aparece como Consultando", () => {
    assert.equal(efdRowState([original], [job("completed", "2026-09-01T00:00:00Z"), job("queued", "2026-09-27T01:00:00Z")]), "checking");
  });

  it("sem declaração: sem mensagem, erro ou não consultada", () => {
    assert.equal(efdRowState([], []), "not_checked");
    assert.equal(efdRowState([], [job("completed", "2026-09-27T01:00:00Z")]), "no_message");
    assert.equal(efdRowState([], [job("failed", "2026-09-27T01:00:00Z")]), "check_failed");
  });

  it("problemas: malha, pendência, não processada e erro", () => {
    assert.deepEqual(
      (["processed", "alert", "pending", "not_processed", "check_failed", "no_message"] as const).map(isProblem),
      [false, true, true, true, true, false],
    );
  });

  it("retificadora rejeitada: continua valendo a original processada", () => {
    const originalOk = decl("93104700001", "processed", "2026-08-10T18:20:49Z");
    const retifRejected = decl("93104700002", "not_processed", "2026-08-20T18:00:00Z", "RETIFICADORA");
    assert.equal(stillValidAfterRejectedRetif([originalOk, retifRejected])?.epe_number, "93104700001");
    assert.equal(efdRowState([originalOk, retifRejected], []), "retif_rejected");
    assert.equal(isProblem("retif_rejected"), true);
    // original rejeitada sem nada processado antes continua "Não processada"
    assert.equal(efdRowState([original], []), "not_processed");
  });
});

describe("EFD no refino: abas, gravidade e dica", () => {
  const inc = (type: number) => ({ type, type_label: "", rule: "R", description: "d" });

  it("cada situação numa aba; consultando só em Todos", () => {
    assert.equal(efdTab("retif_rejected"), "not_processed");
    assert.equal(efdTab("alert"), "pending");
    assert.equal(efdTab("check_failed"), "missing");
    assert.equal(efdTab("checking"), null);
    assert.ok(EFD_SEVERITY.indexOf("not_processed") < EFD_SEVERITY.indexOf("processed"));
  });

  it("resumo por tipo; com impeditiva fica em vermelho", () => {
    const d = { ...decl("1", "not_processed", "2026-09-14T20:30:00Z"), inconsistencies: [inc(1)] };
    assert.deepEqual(efdHint("not_processed", [d], null), { text: "1 impeditiva", tone: "danger" });
  });

  it("pendência (Tipo 2) ganha o prazo de 45 dias", () => {
    const d = { ...decl("1", "pending", "2026-09-13T11:47:00Z"), inconsistencies: [inc(2), inc(3)] };
    const hint = efdHint("pending", [d], null, new Date("2026-10-03T12:00:00Z"));
    assert.deepEqual(hint, { text: "1 pendência · 1 alerta · até 28/10 · 25 dias", tone: "warn" });
    const late = efdHint("pending", [d], null, new Date("2026-11-20T12:00:00Z"));
    assert.equal(late?.text, "1 pendência · 1 alerta · prazo venceu em 28/10");
  });

  it("retificadora rejeitada mostra qual continua valendo", () => {
    const orig = decl("1", "processed", "2026-09-10T15:00:00Z");
    const retif = decl("2", "not_processed", "2026-09-20T12:15:00Z", "RETIFICADORA");
    assert.deepEqual(efdHint("retif_rejected", [orig, retif], null), { text: "vale a original de 10/09", tone: "danger" });
  });

  it("erro na consulta e sem dica para processada limpa", () => {
    const failed = { ...job("failed", "2026-10-01T00:00:00Z"), error_message: "SIAT indisponível" };
    assert.equal(efdHint("check_failed", [], failed)?.text, "SIAT indisponível · tente de novo");
    assert.equal(efdHint("processed", [decl("1", "processed", "2026-09-10T15:00:00Z")], null), null);
  });
});
