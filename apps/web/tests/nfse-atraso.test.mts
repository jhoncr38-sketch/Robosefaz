// Aviso de atraso do repasse da NFS-e ao ambiente nacional (tela NFS-e Nacional).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type AdnDelayRow, delayNotices as notices, formatDelay, monthBounds, monthClosing, monthCovered, monthName, previousMonth, shortDay } from "../src/lib/nfse-atraso.ts";

const HOUR = 3600;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-12T12:00:00-03:00");
// última chegada registrada três dias antes: os números são de agora
const row = (over: Partial<AdnDelayRow>): AdnDelayRow => ({ c_loc_emi: "2211001", notas: 60, mediana_s: 30 * HOUR, acima_1d: 24, pior_s: 7 * DAY, ultima_chegada: "2026-10-09T13:29:00-03:00", ...over });
const city = (code: string) => ({ "2211001": "Teresina/PI", "3550308": "São Paulo/SP" })[code];
const delayNotices = (rows: AdnDelayRow[], name: typeof city) => notices(rows, name, NOW);

describe("atraso do repasse da NFS-e ao ambiente nacional", () => {
  it("escreve o tempo do jeito que se fala", () => {
    assert.equal(formatDelay(0), "1 segundo");
    assert.equal(formatDelay(38), "38 segundos");
    assert.equal(formatDelay(21 * 60), "21 minutos");
    assert.equal(formatDelay(60 * 60), "60 minutos");
    assert.equal(formatDelay(2 * HOUR), "2 horas");
    assert.equal(formatDelay(30 * HOUR), "30 horas");
    assert.equal(formatDelay(7.4 * DAY), "7 dias");
    assert.equal(formatDelay(2.1 * DAY), "2 dias");
  });

  it("avisa da cidade em que boa parte das notas leva mais de um dia", () => {
    const [n] = delayNotices([row({})], city);
    assert.deepEqual(n, { codigo: "2211001", cidade: "Teresina/PI", notas: 60, atrasadas: 40, tipico: "30 horas", pior: "7 dias" });
  });

  it("avisa também quando o tempo típico é baixo mas uma parte das notas atrasa dias", () => {
    // outubro de 2026 em Teresina: metade em 21 minutos, 3 em cada 10 com mais de três dias
    const [n] = delayNotices([row({ notas: "20", mediana_s: 21 * 60, acima_1d: "6", pior_s: 5.5 * DAY })], city);
    assert.deepEqual([n.atrasadas, n.tipico, n.pior], [30, "21 minutos", "6 dias"]);
  });

  it("não avisa quando chega em minutos, nem com poucas notas", () => {
    assert.deepEqual(delayNotices([row({ mediana_s: 14 * 60, acima_1d: 0, pior_s: 2 * HOUR })], city), []);
    assert.deepEqual(delayNotices([row({ notas: 4, acima_1d: 4 })], city), []);
    assert.deepEqual(delayNotices([], city), []);
  });

  it("números velhos não aparecem: sem chegada registrada nos últimos 10 dias, a cidade some", () => {
    // é o que acontece enquanto os robôs do escritório ainda não gravam a hora de chegada
    assert.equal(delayNotices([row({ ultima_chegada: "2026-10-03T10:00:00-03:00" })], city).length, 1);
    assert.deepEqual(delayNotices([row({ ultima_chegada: "2026-10-01T10:00:00-03:00" })], city), []);
    assert.deepEqual(delayNotices([row({ ultima_chegada: null })], city), []);
    assert.deepEqual(delayNotices([row({ ultima_chegada: "ontem" })], city), []);
  });

  it("uma linha por cidade, a de mais notas primeiro; cidade fora da tabela aparece pelo código", () => {
    const list = delayNotices([row({ c_loc_emi: "9999999", notas: 8, acima_1d: 8 }), row({}), row({ c_loc_emi: "3550308", notas: 30, acima_1d: 0, mediana_s: 5 * HOUR })], city);
    assert.deepEqual(list.map((n) => n.cidade), ["Teresina/PI", "São Paulo/SP", "município 9999999"]);
    assert.equal(list[1].atrasadas, 0);
  });
});

describe("o mês anterior já está aqui?", () => {
  const arrived = (iso: string, city = "2211001") => ({ c_loc_emi: city, adn_recebida_em: iso });
  // setembro de 2026 em Teresina: 3 notas no próprio mês e 2 que só chegaram em 7 de outubro
  const SEPTEMBER = [
    arrived("2026-09-10T10:00:00-03:00"),
    arrived("2026-09-20T15:00:00-03:00"),
    arrived("2026-09-30T23:50:00-03:00"),
    arrived("2026-10-07T20:00:00-03:00"),
    arrived("2026-10-07T23:28:00-03:00"),
  ];

  it("mês anterior e seus limites, no horário de Brasília", () => {
    assert.equal(previousMonth(new Date("2026-10-12T12:00:00-03:00")), "2026-09");
    assert.equal(previousMonth(new Date("2026-01-05T12:00:00-03:00")), "2025-12");
    // 1º de outubro às 01:00 UTC ainda é 30 de setembro em Brasília
    assert.equal(previousMonth(new Date("2026-10-01T01:00:00Z")), "2026-08");
    assert.deepEqual(monthBounds("2026-09"), { start: "2026-09-01T00:00:00-03:00", end: "2026-10-01T00:00:00-03:00" });
    assert.deepEqual(monthBounds("2026-12"), { start: "2026-12-01T00:00:00-03:00", end: "2027-01-01T00:00:00-03:00" });
    assert.equal(monthName("2026-09"), "setembro");
    assert.equal(shortDay("2026-10-08T02:28:00Z"), "07/10");
  });

  it("as atrasadas chegaram e todas as buscas são posteriores: provavelmente completo", () => {
    const c = monthClosing(SEPTEMBER, "2026-09", ["2026-10-10T09:32:00-03:00", "2026-10-10T10:43:00-03:00", null])["2211001"];
    assert.deepEqual([c.notas, c.atrasadas, c.buscasAntigas, c.situacao], [5, 2, 0, "provavel"]);
    assert.equal(shortDay(c.ultimaChegada!), "07/10");
    assert.equal(shortDay(c.buscaMaisAntiga!), "10/10");
  });

  it("empresa buscada antes de a última atrasada chegar: buscar de novo", () => {
    const c = monthClosing(SEPTEMBER, "2026-09", ["2026-10-06T09:00:00-03:00", "2026-10-10T10:43:00-03:00"])["2211001"];
    assert.deepEqual([c.buscasAntigas, c.situacao], [1, "buscar"]);
  });

  it("sem atrasadas vale o fim do mês: busca feita ainda em setembro não serve", () => {
    const inMonth = SEPTEMBER.slice(0, 3);
    const after = monthClosing(inMonth, "2026-09", ["2026-10-01T08:00:00-03:00"])["2211001"];
    const before = monthClosing(inMonth, "2026-09", ["2026-09-30T18:00:00-03:00"])["2211001"];
    assert.deepEqual([after.situacao, after.ultimaChegada, before.situacao], ["provavel", null, "buscar"]);
  });

  it("só fala do mês quando quase todas as notas dele têm a hora de chegada", () => {
    assert.equal(monthCovered(82, 82), true);
    assert.equal(monthCovered(100, 90), true);
    assert.equal(monthCovered(100, 89), false); // parte das notas veio de robô que ainda não grava a hora
    assert.equal(monthCovered(38, 26), false);
    assert.equal(monthCovered(0, 0), false);
  });

  it("uma situação por cidade; sem nenhuma busca, pede a busca; mês sem notas não aparece", () => {
    const all = monthClosing([...SEPTEMBER, arrived("2026-09-12T09:00:00-03:00", "3550308")], "2026-09", []);
    assert.deepEqual(Object.keys(all).sort(), ["2211001", "3550308"]);
    assert.equal(all["3550308"].situacao, "buscar");
    assert.deepEqual(monthClosing([], "2026-09", ["2026-10-10T09:00:00-03:00"]), {});
  });
});
