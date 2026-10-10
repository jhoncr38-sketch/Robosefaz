// Empresa só de serviço (sem SIAT): situação na tela Executar automações.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blocksNewRequest, plannerStatusMap } from "../src/lib/competence-status.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("situação na tela Executar automações", () => {
  const job = (client_id: string, operations: string[], status: "completed" | "queued" | "failed") => ({
    client_id,
    competence: "2026-09",
    status,
    created_at: "2026-10-05T12:00:00Z",
    operations,
  });

  it("para a empresa só de serviço vale a busca de NFS-e; para as outras, as notas do mês", () => {
    const jobs = [
      job(A, ["NFSE_FETCH"], "completed"), // A usa o SIAT: a busca de NFS-e não conta como mês solicitado
      job(B, ["NFSE_FETCH"], "completed"), // B é só serviço: conta
    ];
    const map = plannerStatusMap(jobs, "2026-09", new Set([B]));
    assert.equal(map[A], undefined);
    assert.equal(map[B], "done");
    assert.ok(blocksNewRequest(map[B]));
  });

  it("pedido de notas do SIAT continua valendo para quem usa o SIAT", () => {
    const map = plannerStatusMap([job(A, ["NFCE_EXPORT", "NFE_ISSUED_EXPORT"], "queued"), job(B, ["NFCE_EXPORT"], "failed")], "2026-09", new Set([B]));
    assert.equal(map[A], "queued");
    assert.equal(map[B], undefined); // B não usa o SIAT: um pedido antigo de SIAT não conta
  });
});
