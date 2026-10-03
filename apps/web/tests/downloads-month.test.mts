// Downloads por mês: uma linha por cliente, um bloco por tipo, situação do cliente.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { filterBlocks, monthClients, typeFilterFromDoc } from "../src/lib/downloads-month.ts";
import type { NoMovementRow } from "../src/lib/no-movement.ts";
import type { DocumentType, DownloadRow } from "../src/lib/types.ts";

const clients = [
  { id: "lia", client_code: "CLI000001", legal_name: "LIA PAPELARIA", trade_name: null, cnpj: "11111111000111" },
  { id: "abc", client_code: "CLI000002", legal_name: "ABC COMERCIO", trade_name: null, cnpj: "22222222000122" },
  { id: "zed", client_code: "CLI000003", legal_name: "ZED LTDA", trade_name: null, cnpj: "33333333000133", active: false },
  { id: "nada", client_code: "CLI000004", legal_name: "NADA PEDIDO", trade_name: null, cnpj: "44444444000144" },
];

function file(id: string, client: string, doc: DocumentType, extra: Partial<DownloadRow> = {}): DownloadRow {
  return {
    id,
    client_id: client,
    document_type: doc,
    competence: "2026-09",
    filename: `${id}.zip`,
    size: 5000,
    note_count: 10,
    downloaded_at: "2026-10-01T12:00:00Z",
    drive_file_id: null,
    ...extra,
  } as DownloadRow;
}

function none(id: string, client: string, doc: DocumentType, at = "2026-10-01T12:00:00Z"): NoMovementRow {
  return { id, client_id: client, job_id: "j", competence: "2026-09", document_type: doc, checked_at: at, external_request_id: null };
}

describe("uma linha por cliente", () => {
  it("blocos na ordem do tipo, o arquivo mais novo vale e a situação do cliente", () => {
    const rows = monthClients(
      [
        file("old", "lia", "NFCE", { note_count: 3, downloaded_at: "2026-10-01T10:00:00Z" }),
        file("new", "lia", "NFCE", { note_count: 7 }),
        file("canc", "lia", "NFCE_CANCELADAS", { note_count: 2 }),
      ],
      [none("n1", "lia", "NFE_RECEBIDAS"), none("n2", "abc", "NFCE")],
      [
        { client_id: "abc", document_type: "NFE_EMITIDAS", status: "scheduled", created_at: "2026-10-01T00:00:00Z" },
        { client_id: "zed", document_type: "NFCE", status: "scheduled", created_at: "2026-10-01T00:00:00Z" },
      ],
      clients,
    );
    // ordem alfabética; inativo sem resposta e cliente sem pedido não aparecem
    assert.deepEqual(rows.map((r) => r.code), ["CLI000002", "CLI000001"]);
    const [abc, lia] = rows;
    assert.deepEqual(
      lia.blocks.map((b) => [b.doc, b.state, b.count]),
      [
        ["NFCE", "file", 7],
        ["NFE_RECEBIDAS", "empty", 0],
        ["NFCE_CANCELADAS", "file", 2],
      ],
    );
    assert.equal(lia.situation, "com");
    assert.deepEqual(lia.files.map((f) => f.id), ["new", "canc"]);
    assert.deepEqual(abc.blocks.map((b) => b.state), ["empty", "waiting"]);
    assert.equal(abc.situation, "resp"); // ainda falta a resposta das emitidas
  });

  it("ZIP vazio ou contado com 0 notas é sem movimento; sem movimento mais novo vale sobre o arquivo", () => {
    const rows = monthClients(
      [file("z", "lia", "NFCE", { size: 22 }), file("e", "abc", "NFE_EMITIDAS", { downloaded_at: "2026-10-01T10:00:00Z" })],
      [none("n", "abc", "NFE_EMITIDAS", "2026-10-02T10:00:00Z")],
      [],
      clients,
    );
    assert.deepEqual(rows.map((r) => [r.code, r.situation, r.blocks[0].state]), [
      ["CLI000002", "sem", "empty"],
      ["CLI000001", "sem", "empty"],
    ]);
    assert.equal(rows[1].files.length, 0); // nada para baixar
  });

  it("aviso de mês para conferir marca o cliente", () => {
    const alert = { kind: "drop" as const, count: 38, average: 1200, months: 3, text: "Só 38 notas" };
    const rows = monthClients([file("f", "lia", "NFCE", { note_count: 38 })], [], [], clients, { f: alert });
    assert.equal(rows[0].toCheck, true);
    assert.equal(rows[0].blocks[0].alert?.average, 1200);
  });
});

describe("chips de tipo", () => {
  it("filtra os blocos e some com quem fica sem nenhum", () => {
    const rows = monthClients(
      [file("a", "lia", "NFCE"), file("b", "lia", "NFE_EMITIDAS_CANCELADAS"), file("c", "abc", "NFE_RECEBIDAS")],
      [],
      [],
      clients,
    );
    assert.deepEqual(filterBlocks(rows, "canc").map((r) => [r.code, r.blocks.map((b) => b.doc)]), [
      ["CLI000001", ["NFE_EMITIDAS_CANCELADAS"]],
    ]);
    assert.equal(filterBlocks(rows, "all"), rows);
  });

  it("chip pela URL antiga (?type=)", () => {
    assert.equal(typeFilterFromDoc("NFE_EMITIDAS"), "emit");
    assert.equal(typeFilterFromDoc("NFCE_CANCELADAS"), "canc");
    assert.equal(typeFilterFromDoc("XYZ"), "all");
  });
});
