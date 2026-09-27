// Consulta EFD: situação de cada cliente na competência.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { efdRowState, isProblem, latestDeclaration, type EfdCheckJob } from "../src/lib/efd.ts";
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
});
