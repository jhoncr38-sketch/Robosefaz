// Notas canceladas: botão "Canceladas" do agendamento, etiqueta na tela Downloads e o que não conta.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isExportJob } from "../src/lib/competence-status.ts";
import { monthSummary } from "../src/lib/no-movement.ts";
import { noteAlerts } from "../src/lib/note-count.ts";
import { baseDocument, DOCUMENT_LABEL, isCanceledDocument, withCanceled } from "../src/lib/status.ts";

describe("notas canceladas", () => {
  it("com o botão ligado, cada tipo marcado ganha o pedido de canceladas logo depois", () => {
    assert.deepEqual(withCanceled(["NFCE_EXPORT", "NFE_RECEIVED_EXPORT"], false), ["NFCE_EXPORT", "NFE_RECEIVED_EXPORT"]);
    assert.deepEqual(withCanceled(["NFCE_EXPORT", "NFE_RECEIVED_EXPORT"], true), [
      "NFCE_EXPORT",
      "NFCE_CANCELED_EXPORT",
      "NFE_RECEIVED_EXPORT",
      "NFE_RECEIVED_CANCELED_EXPORT",
    ]);
    assert.deepEqual(withCanceled([], true), []); // canceladas só dos tipos marcados
  });

  it("tipo curto + etiqueta 'canceladas'", () => {
    assert.equal(isCanceledDocument("NFE_EMITIDAS_CANCELADAS"), true);
    assert.equal(isCanceledDocument("NFE_EMITIDAS"), false);
    assert.equal(DOCUMENT_LABEL[baseDocument("NFE_EMITIDAS_CANCELADAS")], "NF-e emitidas");
    assert.equal(DOCUMENT_LABEL.NFCE_CANCELADAS, "NFC-e canceladas"); // filtro Tipo e celular
  });

  it("pedir só as canceladas não marca o mês como solicitado", () => {
    assert.equal(isExportJob({ operations: ["NFCE_CANCELED_EXPORT", "NFE_ISSUED_CANCELED_EXPORT"] }), false);
    assert.equal(isExportJob({ operations: ["NFCE_EXPORT", "NFCE_CANCELED_EXPORT"] }), true);
    assert.equal(isExportJob({ operations: ["EFD_CHECK"] }), false);
    assert.equal(isExportJob({}), true);
  });

  it("canceladas não geram aviso de mês para conferir nem entram no resumo do mês", () => {
    // baixadas no dia 2 do mês seguinte (mês completo); se fossem notas ativas, agosto zerado avisaria
    const dl = (competence: string, downloaded: string, note_count: number) => ({
      id: competence,
      client_id: "lia",
      document_type: "NFE_EMITIDAS_CANCELADAS" as const,
      competence,
      note_count,
      downloaded_at: `${downloaded}-02T12:00:00Z`,
    });
    const rows = [dl("2026-05", "2026-06", 40), dl("2026-06", "2026-07", 45), dl("2026-07", "2026-08", 50), dl("2026-08", "2026-09", 0)];
    assert.deepEqual(noteAlerts(rows, rows, new Date("2026-10-01T12:00:00Z")), {});

    const summary = monthSummary(
      [
        { client_id: "lia", document_type: "NFE_EMITIDAS", filename: "a.zip", size: 9000, note_count: 3 },
        { client_id: "lia", document_type: "NFE_EMITIDAS_CANCELADAS", filename: "b.zip", size: 9000, note_count: 1 },
      ],
      [],
      [],
    );
    assert.deepEqual(summary, { clients: 1, withNotes: 1, noMovement: 0, waiting: 0 });
  });
});
