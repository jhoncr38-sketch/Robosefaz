// "Sem movimento" na tela Downloads: lista junto com os arquivos, filtro e resumo do mês.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  asZeroCount,
  downloadEntries,
  hasNotes,
  monthSummary,
  noMovementFromTasks,
  parseSituation,
  type NoMovementRow,
} from "../src/lib/no-movement.ts";
import type { DownloadRow } from "../src/lib/types.ts";

const file = (over: Partial<DownloadRow> = {}): DownloadRow => ({
  id: "f1",
  client_id: "lia",
  job_id: "j1",
  automation_task_id: null,
  document_type: "NFCE",
  competence: "2026-09",
  filename: "LIA - NFC-e - 09-2026 - CLI000001.zip",
  filepath: "H:/x.zip",
  size: 6_108_535,
  checksum: "a".repeat(64),
  downloaded_at: "2026-10-01T17:55:00Z",
  note_count: 2308,
  ...over,
});

const empty = (over: Partial<NoMovementRow> = {}): NoMovementRow => ({
  id: "t1",
  client_id: "metro",
  job_id: "j2",
  competence: "2026-09",
  document_type: "NFE_EMITIDAS",
  checked_at: "2026-10-01T19:47:00Z",
  external_request_id: "9350341",
  ...over,
});

describe("sem movimento", () => {
  it("ZIP vazio antigo ou contado com 0 notas não é 'com notas'", () => {
    assert.equal(hasNotes(file()), true);
    assert.equal(hasNotes(file({ size: 22, note_count: null })), false);
    assert.equal(hasNotes(file({ size: 4000, note_count: 0 })), false);
    assert.equal(hasNotes(file({ note_count: null })), true); // ainda não contado
  });

  it("lista arquivos e sem movimento juntos, do mais recente para o mais antigo", () => {
    const old = file({ id: "f0", downloaded_at: "2026-09-30T10:00:00Z" });
    const entries = downloadEntries([file(), old], [empty()]);
    assert.deepEqual(
      entries.map((e) => (e.kind === "file" ? e.d.id : e.n.id)),
      ["t1", "f1", "f0"],
    );
  });

  it("filtro de situação", () => {
    const zip = file({ id: "z", size: 22, note_count: 0 });
    const ids = (s?: "com-notas" | "sem-movimento") =>
      downloadEntries([file(), zip], [empty()], s).map((e) => (e.kind === "file" ? e.d.id : e.n.id));
    assert.deepEqual(ids("com-notas"), ["f1"]);
    assert.deepEqual(ids("sem-movimento").sort(), ["t1", "z"]);
    assert.equal(parseSituation("sem-movimento"), "sem-movimento");
    assert.equal(parseSituation("outra"), undefined);
  });

  it("vira mês com 0 notas para o aviso de 'mês para conferir'", () => {
    assert.deepEqual(asZeroCount(empty()), {
      id: "t1",
      client_id: "metro",
      document_type: "NFE_EMITIDAS",
      competence: "2026-09",
      note_count: 0,
      downloaded_at: "2026-10-01T19:47:00Z",
    });
  });

  it("página do trabalho: tarefas de exportação concluídas sem notas", () => {
    const base = {
      job_id: "j2",
      client_id: "metro",
      competence: "2026-09",
      finished_at: "2026-10-01T19:47:00Z",
      external_request_id: "9350298",
    };
    const rows = noMovementFromTasks([
      { ...base, id: "a", task_type: "NFCE_EXPORT", status: "completed", document_type: "NFCE", result: { no_notes: true } },
      { ...base, id: "b", task_type: "DOWNLOAD", status: "completed", document_type: "NFCE", result: { no_notes: true } },
      { ...base, id: "c", task_type: "NFE_ISSUED_EXPORT", status: "completed", document_type: "NFE_EMITIDAS", result: {} },
      { ...base, id: "d", task_type: "NFE_RECEIVED_EXPORT", status: "scheduled", document_type: "NFE_RECEBIDAS", result: {} },
    ]);
    assert.deepEqual(rows.map((r) => r.id), ["a"]);
    assert.equal(rows[0].checked_at, "2026-10-01T19:47:00Z");
  });

  it("resumo do mês: cada cliente + tipo conta uma vez", () => {
    const t = (client_id: string, document_type: "NFCE" | "NFE_EMITIDAS", status: "completed" | "scheduled" | "failed" | "skipped", created_at = "2026-10-01T17:00:00Z") => ({
      client_id,
      document_type,
      status,
      created_at,
    });
    const summary = monthSummary(
      [file(), file({ id: "f2" }), file({ id: "z", client_id: "silva", size: 22, note_count: 0 })],
      [empty(), empty({ id: "t2", client_id: "lia", document_type: "NFCE" })], // lia NFC-e tem arquivo: vale "com notas"
      [
        t("lia", "NFCE", "completed"),
        t("metro", "NFE_EMITIDAS", "completed"),
        t("4n", "NFCE", "scheduled"), // aguardando o PC com o certificado
        t("ml", "NFCE", "failed"), // inativo: não conta
        t("bolo", "NFCE", "failed", "2026-10-01T15:00:00Z"),
        t("bolo", "NFCE", "completed", "2026-10-01T16:00:00Z"), // tentou de novo e terminou (sem arquivo/sem resposta registrada)
        t("seleto", "NFE_EMITIDAS", "skipped"),
      ],
      new Set(["ml"]),
    );
    assert.deepEqual(summary, { clients: 4, withNotes: 1, noMovement: 2, waiting: 1 });
  });
});
