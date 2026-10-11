// Trabalho esperando um computador desligado (repasse de certificado ou nenhum robô ligado).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computersFrom, groupText, groupWaits, hostOf, offlineSince, pcWait } from "../src/lib/pc-wait.ts";

const NOW = Date.parse("2026-10-01T22:45:00Z"); // 19:45 no Piauí

const hb = (worker_id: string, last_seen_at: string, hostname: string | null = null, status = "idle") => ({
  worker_id,
  hostname,
  status,
  last_seen_at,
});

// 01/10 à noite: este notebook ligado, o PC do Alex desligado desde 17:31
const HEARTBEATS = [
  hb("DESKTOP-TESTE01-12656", "2026-10-01T22:44:40Z", "DESKTOP-TESTE01"),
  hb("DESKTOP-TESTE01-11244", "2026-10-01T22:33:00Z", "DESKTOP-TESTE01"),
  hb("Alex-17420", "2026-10-01T20:31:00Z"),
  hb("Alex-11200", "2026-10-01T15:08:00Z"),
];

describe("trabalho esperando computador", () => {
  it("um computador por nome, com o último sinal", () => {
    assert.equal(hostOf({ worker_id: "Alex-17420" }), "Alex");
    assert.deepEqual(
      computersFrom(HEARTBEATS, NOW).map((c) => [c.hostname, c.online]),
      [
        ["DESKTOP-TESTE01", true],
        ["Alex", false],
      ],
    );
  });

  it("4N: este PC não tem o certificado e o do Alex está desligado", () => {
    const wait = pcWait({ status: "waiting_sefaz", locked_by: null, skip_hosts: ["DESKTOP-TESTE01"] }, computersFrom(HEARTBEATS, NOW));
    assert.equal(wait?.kind, "handover");
    const [group] = groupWaits([{ job: "4N", wait: wait! }]);
    const text = groupText(group, new Date(NOW), "XY ENGENHARIA");
    assert.equal(text.title, "Aguardando o PC Alex");
    assert.equal(text.status, "desligado há 2h");
    assert.deepEqual(text.steps, [
      "Ligue o PC Alex: o trabalho continua sozinho.",
      "Ou instale o certificado de XY ENGENHARIA em DESKTOP-TESTE01, cancele o trabalho na fila e clique em Reprocessar.",
    ]);
    assert.equal(text.action, text.steps.join(" "));
  });

  it("sem aviso quando outro computador ligado pode pegar, ou o trabalho já está com um", () => {
    const pcs = computersFrom(HEARTBEATS, NOW);
    assert.equal(pcWait({ status: "queued", locked_by: null, skip_hosts: ["Alex"] }, pcs), null);
    assert.equal(pcWait({ status: "queued", locked_by: null, skip_hosts: [] }, pcs), null);
    assert.equal(pcWait({ status: "downloading", locked_by: "Alex-17420", skip_hosts: ["DESKTOP-TESTE01"] }, pcs), null);
    assert.equal(pcWait({ status: "completed", locked_by: null, skip_hosts: ["DESKTOP-TESTE01"] }, pcs), null);
  });

  it("vários trabalhos esperando o mesmo PC viram um grupo só", () => {
    const pcs = computersFrom(HEARTBEATS, NOW);
    const w = (skip: string[]) => pcWait({ status: "queued", locked_by: null, skip_hosts: skip }, pcs)!;
    const groups = groupWaits([
      { job: "a", wait: w(["DESKTOP-TESTE01"]) },
      { job: "b", wait: w(["DESKTOP-TESTE01"]) },
      { job: "c", wait: w(["DESKTOP-TESTE01"]) },
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].jobs, ["a", "b", "c"]);
    assert.match(groupText(groups[0], new Date(NOW)).action, /os certificados destes clientes em DESKTOP-TESTE01/);
  });

  it("nenhum computador conhecido tem o certificado", () => {
    const wait = pcWait({ status: "queued", locked_by: null, skip_hosts: ["DESKTOP-TESTE01"] }, computersFrom([HEARTBEATS[0]], NOW));
    assert.deepEqual(wait, { kind: "no_other_pc", without: ["DESKTOP-TESTE01"] });
  });

  it("nenhum robô ligado (ex.: o notebook suspenso das 13:47 às 17:47)", () => {
    const at = Date.parse("2026-10-01T18:00:00Z");
    const pcs = computersFrom(
      [hb("DESKTOP-TESTE01-18544", "2026-10-01T16:46:00Z", "DESKTOP-TESTE01"), hb("Alex-1", "2026-10-01T15:00:00Z", null, "stopped")],
      at,
    );
    const wait = pcWait({ status: "queued", locked_by: null, skip_hosts: [] }, pcs)!;
    assert.equal(wait.kind, "none_online");
    const text = groupText(groupWaits([{ job: "x", wait }])[0], new Date(at));
    assert.equal(text.status, "último sinal de DESKTOP-TESTE01 há 1h");
  });

  it("tempo desligado em minutos, horas ou data", () => {
    const c = (last: string) => ({ hostname: "Alex", last_seen_at: last, online: false });
    assert.equal(offlineSince(c("2026-10-01T22:16:00Z"), new Date(NOW)), "há 29 min");
    assert.equal(offlineSince(c("2026-10-01T20:31:00Z"), new Date(NOW)), "há 2h");
    assert.equal(offlineSince(c("2026-09-30T21:06:00Z"), new Date(NOW)), "desde 30/09/2026 18:06");
  });
});
