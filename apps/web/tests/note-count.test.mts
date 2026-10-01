// Quantidade de notas: aviso de mês sem notas ou com queda brusca.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { noteAlerts, notesLabel, type NoteCountRow } from "../src/lib/note-count.ts";

const NOW = new Date("2026-10-01T15:00:00Z");

let seq = 0;
// baixado no dia 2 do mês seguinte (mês completo), salvo se `at` for informado
const dl = (competence: string, note_count: number | null, over: Partial<NoteCountRow> = {}): NoteCountRow => {
  const [y, m] = competence.split("-").map(Number);
  const next = new Date(Date.UTC(y, m, 2, 12));
  seq += 1;
  return {
    id: `d${seq}`,
    client_id: "santa-zelia",
    document_type: "NFCE",
    competence,
    note_count,
    downloaded_at: next.toISOString(),
    ...over,
  };
};

describe("quantidade de notas", () => {
  it("rótulo em português", () => {
    assert.equal(notesLabel(1), "1 nota");
    assert.equal(notesLabel(0), "0 notas");
    assert.equal(notesLabel(2308), "2.308 notas");
  });

  it("mês normal: sem aviso", () => {
    const rows = [dl("2026-05", 220), dl("2026-06", 240), dl("2026-07", 230), dl("2026-08", 210)];
    assert.deepEqual(noteAlerts(rows, rows, NOW), {});
  });

  it("ZIP vazio num cliente que costuma ter notas: aviso de nenhuma nota", () => {
    const zero = dl("2026-08", 0);
    const rows = [dl("2026-05", 220), dl("2026-06", 240), dl("2026-07", 230), zero];
    const a = noteAlerts(rows, rows, NOW)[zero.id];
    assert.equal(a.kind, "zero");
    assert.equal(a.average, 230);
    assert.equal(a.text, "Nenhuma nota neste mês. Nos 3 meses anteriores a média foi de 230 notas.");
  });

  it("queda para menos da metade: aviso", () => {
    const low = dl("2026-08", 40);
    const rows = [dl("2026-06", 240), dl("2026-07", 230), low];
    const a = noteAlerts(rows, rows, NOW)[low.id];
    assert.equal(a.kind, "drop");
    assert.equal(a.text, "Só 40 notas neste mês. Nos 2 meses anteriores a média foi de 235 notas.");
  });

  it("cliente pequeno: oscilação de poucas notas não é aviso", () => {
    const rows = [dl("2026-06", 8), dl("2026-07", 6), dl("2026-08", 2), dl("2026-09", 0)];
    assert.deepEqual(noteAlerts(rows, rows, NOW), {}); // queda de menos de 10 notas
  });

  it("pouco histórico: sem aviso (precisa de 2 meses anteriores)", () => {
    const rows = [dl("2026-07", 300), dl("2026-08", 0)];
    assert.deepEqual(noteAlerts(rows, rows, NOW), {});
  });

  it("mês corrente ou baixado antes de terminar: sem aviso e fora da média", () => {
    const partial = dl("2026-09", 10, { downloaded_at: "2026-09-15T12:00:00Z" });
    const current = dl("2026-10", 0, { downloaded_at: "2026-10-01T12:00:00Z" });
    const rows = [dl("2026-06", 240), dl("2026-07", 230), dl("2026-08", 220), partial, current];
    assert.deepEqual(noteAlerts(rows, rows, NOW), {});
    // agosto não usa setembro parcial na média, e outubro (corrente) nunca avisa
  });

  it("mesmo mês baixado duas vezes: vale a versão com mais notas", () => {
    const full = dl("2026-08", 225);
    const empty = dl("2026-08", 0, { downloaded_at: "2026-09-20T12:00:00Z" });
    const rows = [dl("2026-06", 240), dl("2026-07", 230), full, empty];
    assert.deepEqual(noteAlerts(rows, rows, NOW), {});
  });

  it("ainda não contado: sem aviso; histórico separado da página", () => {
    const pending = dl("2026-08", null);
    const shown = dl("2026-08", 0, { document_type: "NFE_EMITIDAS" });
    const history = [
      dl("2026-06", 30, { document_type: "NFE_EMITIDAS" }),
      dl("2026-07", 20, { document_type: "NFE_EMITIDAS" }),
      dl("2026-07", 400), // outro tipo não entra na média
    ];
    const alerts = noteAlerts([pending, shown], history, NOW);
    assert.deepEqual(Object.keys(alerts), [shown.id]);
    assert.equal(alerts[shown.id].average, 25);
  });
});
