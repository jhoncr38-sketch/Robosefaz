// Regras do redesenho: situação do cliente na competência e formatações curtas.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { currentCompetence, shiftCompetence } from "../src/lib/competence.ts";
import {
  blocksNewRequest,
  competenceStatusOf,
  countByStatus,
  statusMapFromJobs,
} from "../src/lib/competence-status.ts";
import { formatClock, formatShortAgo } from "../src/lib/format.ts";
import { jobStepIndex } from "../src/lib/job-steps.ts";

describe("situação na competência", () => {
  it("agrupa os status do job", () => {
    assert.equal(competenceStatusOf(null), "none");
    assert.equal(competenceStatusOf({ status: "completed" }), "done");
    assert.equal(competenceStatusOf({ status: "queued" }), "queued");
    assert.equal(competenceStatusOf({ status: "authenticating" }), "running");
    assert.equal(competenceStatusOf({ status: "downloading" }), "sefaz");
    assert.equal(competenceStatusOf({ status: "manual_action_required" }), "attention");
    assert.equal(competenceStatusOf({ status: "failed" }), "failed");
    assert.equal(competenceStatusOf({ status: "cancelled" }), "cancelled");
  });

  it("erro, cancelado e não solicitado podem ser reagendados", () => {
    for (const s of ["none", "failed", "cancelled"] as const) assert.equal(blocksNewRequest(s), false);
    for (const s of ["done", "queued", "running", "sefaz", "attention"] as const) assert.equal(blocksNewRequest(s), true);
  });

  it("vale o job mais recente do cliente naquela competência", () => {
    const jobs = [
      { client_id: "a", competence: "2026-08", status: "failed" as const, created_at: "2026-09-01T10:00:00Z" },
      { client_id: "a", competence: "2026-08", status: "completed" as const, created_at: "2026-09-02T10:00:00Z" },
      { client_id: "b", competence: "2026-07", status: "completed" as const, created_at: "2026-09-02T10:00:00Z" },
    ];
    assert.deepEqual(statusMapFromJobs(jobs, "2026-08"), { a: "done" });
    const counts = countByStatus(["done", "done", "none"]);
    assert.equal(counts.done, 2);
    assert.equal(counts.none, 1);
    assert.equal(counts.failed, 0);
  });
});

describe("competência", () => {
  it("avança e volta meses atravessando o ano", () => {
    assert.equal(shiftCompetence("2026-01", -1), "2025-12");
    assert.equal(shiftCompetence("12/2025", 1), "2026-01");
    assert.equal(shiftCompetence("xx", 1), null);
    assert.equal(currentCompetence(new Date(2026, 8, 26)), "2026-09");
  });
});

describe("formatações curtas", () => {
  const now = new Date(2026, 8, 26, 15, 0, 0);
  it("quando", () => {
    assert.equal(formatShortAgo(new Date(2026, 8, 26, 14, 59, 40).toISOString(), now), "agora");
    assert.equal(formatShortAgo(new Date(2026, 8, 26, 14, 30).toISOString(), now), "30 min");
    assert.equal(formatShortAgo(new Date(2026, 8, 26, 12, 0).toISOString(), now), "3h");
    assert.equal(formatShortAgo(new Date(2026, 8, 25, 20, 0).toISOString(), now), "ontem");
    assert.equal(formatShortAgo(new Date(2026, 8, 12, 9, 0).toISOString(), now), "12/09");
  });
  it("cronômetro", () => {
    assert.equal(formatClock(125), "2:05");
    assert.equal(formatClock(3725), "1:02:05");
    assert.equal(formatClock(-5), "0:00");
  });
  it("etapas do card Agora", () => {
    assert.equal(jobStepIndex("queued"), 0);
    assert.equal(jobStepIndex("selecting_taxpayer"), 1);
    assert.equal(jobStepIndex("scheduling_nfe_received"), 2);
    assert.equal(jobStepIndex("waiting_sefaz"), 3);
    assert.equal(jobStepIndex("organizing_files"), 4);
    assert.equal(jobStepIndex("completed"), -1);
  });
});
