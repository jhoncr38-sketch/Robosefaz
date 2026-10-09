// Tela "Operação do dia": período, explicação automática dos atrasos e faixa dos computadores.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  explainJob,
  hostLines,
  jobMinutes,
  jobRobots,
  type OpJob,
  type OpLog,
  type OpSession,
  parseDay,
  parsePeriod,
  periodBounds,
  sessionEnd,
  shiftDay,
  todayLocal,
} from "../src/lib/operation.ts";

// horário do Piauí -> ISO (UTC-3)
const at = (hhmm: string, day = "2026-10-08") => new Date(`${day}T${hhmm}:00-03:00`).toISOString();
const log = (hhmm: string, msg: string, extra: Partial<OpLog> = {}): OpLog => ({ at: at(hhmm), level: "INFO", step: null, msg, ...extra });

function job(extra: Partial<OpJob>): OpJob {
  return {
    id: "j1",
    client_code: "CLI000036",
    client_name: "BOLITOS",
    operations: ["NFCE_EXPORT", "NFE_ISSUED_EXPORT", "NFE_RECEIVED_EXPORT"],
    competence: "2026-09",
    force: true,
    note_key: false,
    status: "completed",
    attempts: 1,
    check_count: 0,
    created_at: at("16:57"),
    started_at: at("16:57"),
    finished_at: at("17:00"),
    error_code: null,
    message: "Concluído",
    files: 0,
    notes: 0,
    logs: [],
    ...extra,
  };
}

function session(host: string, from: string, to: string, status = "idle", own = true): OpSession {
  return {
    org_id: own ? "a" : "b",
    org_name: own ? "Jhonatan" : "SARA",
    own,
    worker_id: `${host}-1`,
    host,
    version: "1.2.34",
    status,
    started_at: at(from),
    last_seen_at: at(to),
  };
}

describe("período", () => {
  it("manhã, tarde, noite e dia no horário do Piauí", () => {
    assert.deepEqual(periodBounds("2026-10-08", "tarde"), {
      from: "2026-10-08T15:00:00.000Z",
      to: "2026-10-08T21:00:00.000Z",
    });
    assert.deepEqual(periodBounds("2026-10-08", "dia"), {
      from: "2026-10-08T03:00:00.000Z",
      to: "2026-10-09T03:00:00.000Z",
    });
    assert.equal(parsePeriod("xyz"), "dia");
    assert.equal(parsePeriod("manha"), "manha");
    assert.equal(shiftDay("2026-10-01", -1), "2026-09-30");
    // 01:00 UTC do dia 9 ainda é dia 8 no Piauí
    assert.equal(todayLocal(new Date("2026-10-09T01:00:00Z")), "2026-10-08");
    assert.equal(parseDay("2026-10-05"), "2026-10-05");
    assert.equal(parseDay("ontem", new Date("2026-10-09T15:00:00Z")), "2026-10-09");
  });
});

describe("por que o trabalho demorou", () => {
  it("BOLITOS de 08/10: o navegador foi fechado à força e esperou a consulta de 30 min", () => {
    const j = job({
      check_count: 2,
      finished_at: at("19:05"),
      logs: [
        log("16:57", "Job iniciado (tentativa 1) por Alex-20600. Dry-run: não.", { step: "starting" }),
        log("16:59", "Navegador fechado. Collector consultará em 30 min.", { step: "waiting_sefaz" }),
        log("17:30", "Collector: consulta nº 1 dos agendamentos."),
        log("17:31", "[UNEXPECTED] Exception: Page.goto: Connection closed while reading from the driver", { level: "ERROR" }),
        log("18:59", "Collector: consulta nº 2 dos agendamentos."),
        log("19:05", "Concluído", { step: "completed" }),
      ],
    });
    // nenhum robô do escritório entre 17:31 e 18:59
    const sessions = [session("Alex", "14:01", "17:31", "busy"), session("DESKTOP", "18:58", "19:10", "stopped")];
    assert.equal(jobMinutes(j, at("20:00")), 128);
    assert.deepEqual(jobRobots(j), ["Alex"]);
    assert.deepEqual(explainJob(j, sessions, at("20:00")), [
      "O navegador do robô foi fechado à força (computador desligado ou em suspensão)",
      "Esperou a consulta de 30 min para baixar (2 consulta(s))",
      "Nenhum robô do escritório ligado de 17:31 a 18:59",
    ]);
  });

  it("4N de 07/10: SIAT lento, tentativas e robô dado como desligado", () => {
    const j = job({
      status: "failed",
      attempts: 4,
      finished_at: at("11:30"),
      started_at: at("11:02"),
      logs: [
        log("11:02", "Job iniciado (tentativa 1) por Alexandre-19744. Dry-run: não.", { step: "starting" }),
        log("11:08", "[TIMEOUT] TimeoutError: Locator.click: Timeout 30000ms exceeded.", { level: "ERROR" }),
        log("11:08", "retentativa 1/3 em 10s", { level: "WARNING", step: "retry" }),
        log("11:19", "[TIMEOUT] TimeoutError: Page.goto: Timeout 60000ms exceeded.", { level: "ERROR" }),
        log("11:19", "retentativa 2/3 em 30s", { level: "WARNING", step: "retry" }),
        log("11:28", "Robô que executava foi desligado; tentativas esgotadas. (robô anterior: Alexandre-19744)", {
          level: "WARNING",
          step: "recovery",
        }),
      ],
    });
    const reasons = explainJob(j, [session("Alexandre", "08:00", "11:31", "busy")], at("12:00"));
    assert.deepEqual(reasons, [
      "Páginas do SIAT demoraram a responder",
      "O robô Alexandre parou no meio do trabalho (desligado ou em suspensão)",
      "2 nova(s) tentativa(s) depois de erro",
    ]);
  });

  it("certificado em outro computador, seleção manual e SIAT fora do ar", () => {
    const j = job({
      finished_at: at("18:00"),
      logs: [
        log("16:57", "O certificado deste cliente não está instalado neste computador (Alex); trabalho repassado para: Alexandre.", {
          level: "WARNING",
        }),
        log("17:10", "A automação está aguardando sua intervenção: Aguardando seleção do certificado digital.", {
          level: "WARNING",
          step: "waiting_certificate",
        }),
        log("17:20", "[LOGIN_FAILED] O SIAT web abriu sem usuário logado. ERRO 503", { level: "ERROR" }),
      ],
    });
    const reasons = explainJob(j, [session("Alexandre", "16:00", "18:30")], at("18:30"));
    assert.ok(reasons.includes("Certificado não instalado em Alex: repassado a outro computador"));
    assert.ok(reasons.includes("Esperou alguém escolher o certificado no Windows"));
    assert.ok(reasons.includes("SIAT fora do ar (erro 503)"));
  });

  it("trabalho rápido e sem problema não ganha explicação", () => {
    const j = job({
      logs: [
        log("16:57", "Job iniciado (tentativa 1) por DESKTOP-74B4DAU-924. Dry-run: não.", { step: "starting" }),
        log("17:00", "Concluído", { step: "completed" }),
      ],
    });
    assert.deepEqual(explainJob(j, [], at("18:00")), []);
    assert.deepEqual(jobRobots(j), ["DESKTOP-74B4DAU"]);
  });
});

describe("faixa dos computadores", () => {
  it("ligado agora, parou de repente e desligado normalmente", () => {
    const now = at("18:00");
    assert.equal(sessionEnd(session("A", "12:00", "17:59", "idle"), now), "running");
    assert.equal(sessionEnd(session("A", "12:00", "17:31", "busy"), now), "abrupt");
    assert.equal(sessionEnd(session("A", "12:00", "15:00", "stopped"), now), "stopped");

    const { from, to } = periodBounds("2026-10-08", "tarde");
    const lines = hostLines(
      [
        session("Alex", "07:24", "12:04", "idle"),
        session("Alex", "14:01", "17:31", "busy"),
        session("Alex", "15:07", "16:59", "stopped", false), // outro computador "Alex", no escritório SARA
        session("DESKTOP", "12:29", "17:59", "idle"),
      ],
      from,
      to,
      now,
    );
    assert.deepEqual(
      lines.map((l) => [l.host, l.own, l.notes]),
      [
        ["Alex", true, ["parou de repente às 12:04", "parou de repente às 17:31"]], // desligou no almoço sem parar o robô
        ["DESKTOP", true, ["ligado agora"]],
        ["Alex", false, ["desligado às 16:59"]],
      ],
    );
    const alex = lines[0];
    assert.equal(alex.segments.length, 2); // só os 4 min da manhã que caem na tarde (12:00 a 12:04) e a sessão das 14:01
    assert.ok(alex.segments[0].left === 0 && alex.segments[0].width < 2);
    assert.ok(Math.abs(alex.segments[1].left - (2 / 6) * 100 - (1 / 360) * 100) < 1); // começa ~14:01
  });
});
