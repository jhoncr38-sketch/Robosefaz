// Fila de processamento: aba pela URL, ordem das linhas e textos curtos de tempo.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  queueMatches,
  queuePositions,
  queueTabFromParam,
  shortAgo,
  shortDuration,
  sortQueue,
} from "../src/lib/queue-view.ts";
import type { AutomationJob, JobStatus } from "../src/lib/types.ts";

function job(id: string, status: JobStatus, extra: Partial<AutomationJob> = {}): AutomationJob {
  return {
    id,
    client_id: `c-${id}`,
    status,
    created_at: "2026-10-03T10:00:00Z",
    updated_at: "2026-10-03T10:00:00Z",
    next_attempt_at: "2026-10-03T10:00:00Z",
    started_at: null,
    finished_at: null,
    ...extra,
  } as AutomationJob;
}

describe("aba da fila", () => {
  it("vem da URL (?aba=intervencao) e cai em Em andamento", () => {
    assert.equal(queueTabFromParam("intervencao"), "manual");
    assert.equal(queueTabFromParam(["finalizados"]), "finished");
    assert.equal(queueTabFromParam("xyz"), "active");
    assert.equal(queueTabFromParam(undefined), "active");
  });

  it("intervenção inclui o certificado necessário", () => {
    assert.ok(queueMatches("manual", job("a", "certificate_required")));
    assert.ok(queueMatches("manual", job("b", "waiting_certificate")));
    assert.ok(!queueMatches("manual", job("c", "failed")));
  });
});

describe("ordem da fila", () => {
  it("na fila numerada como o robô pega (próxima tentativa, depois criação)", () => {
    const jobs = [
      job("b", "queued", { next_attempt_at: "2026-10-03T10:05:00Z" }),
      job("a", "queued", { next_attempt_at: "2026-10-03T10:00:00Z", created_at: "2026-10-03T09:59:00Z" }),
      job("c", "queued", { next_attempt_at: "2026-10-03T10:00:00Z", created_at: "2026-10-03T10:01:00Z" }),
      job("r", "scheduling_nfce"),
    ];
    assert.deepEqual([...queuePositions(jobs)], [["a", 1], ["c", 2], ["b", 3]]);
    // quem está rodando vem no topo, depois a fila na ordem
    assert.deepEqual(sortQueue(jobs).map((j) => j.id), ["r", "a", "c", "b"]);
  });

  it("SEFAZ: quem espera há mais tempo primeiro; finalizados mais recentes primeiro", () => {
    const jobs = [
      job("s1", "waiting_sefaz"),
      job("s2", "waiting_sefaz"),
      job("f1", "completed", { finished_at: "2026-10-03T08:00:00Z" }),
      job("f2", "failed", { finished_at: "2026-10-03T09:00:00Z" }),
      job("m", "manual_action_required"),
    ];
    const since = { s1: "2026-10-03T09:00:00Z", s2: "2026-10-03T07:00:00Z" };
    assert.deepEqual(sortQueue(jobs, since).map((j) => j.id), ["m", "s2", "s1", "f2", "f1"]);
  });
});

describe("tempo curto", () => {
  it("duração do trabalho finalizado", () => {
    assert.equal(shortDuration(45), "45 s");
    assert.equal(shortDuration(38 * 60), "38 min");
    assert.equal(shortDuration(65 * 60), "1h05");
  });

  it("há quanto tempo", () => {
    assert.equal(shortAgo(20_000), "agora");
    assert.equal(shortAgo(26 * 60_000), "há 26 min");
    assert.equal(shortAgo(3 * 3600_000), "há 3h");
    assert.equal(shortAgo(130 * 60_000), "há 2h10");
  });
});
