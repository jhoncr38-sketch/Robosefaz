// Resultados › Faturamento: as linhas do resumo viram a visão de uma empresa e a de todas. Valores fictícios.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatAmount,
  formatBRL,
  monthLabel,
  monthsOf,
  monthView,
  officeColumns,
  officeMonth,
  pickCompetence,
  pickMonth,
  sortForSide,
} from "../src/lib/faturamento.ts";

const clients = [
  {
    id: "a",
    client_code: "CLI000001",
    name: "Padaria Modelo",
    cnpj: "12345678000100",
  },
  {
    id: "b",
    client_code: "CLI000002",
    name: "Clínica Exemplo",
    cnpj: "23456789000100",
  },
  {
    id: "c",
    client_code: "CLI000003",
    name: "Oficina Fictícia",
    cnpj: "34567890000100",
  },
  {
    id: "d",
    client_code: "CLI000004",
    name: "Armazém Teste",
    cnpj: "45678901000100",
  },
];
const rows = [
  {
    client_id: "a",
    competence: "2026-09",
    saidas: "48200",
    entradas: "21900",
    prestados: 0,
    tomados: 0,
    notas: 312,
    canceladas: 1,
  },
  {
    client_id: "b",
    competence: "2026-09",
    saidas: 0,
    entradas: "4100",
    prestados: "36500",
    tomados: "1200",
    notas: 27,
    canceladas: 0,
  },
  {
    client_id: "c",
    competence: "2026-09",
    saidas: "12300",
    entradas: "9800",
    prestados: "2000",
    tomados: 0,
    notas: 58,
    canceladas: 0,
  },
  {
    client_id: "c",
    competence: "2026-08",
    saidas: "100",
    entradas: 0,
    prestados: 0,
    tomados: 0,
    notas: 1,
    canceladas: 0,
  },
];

describe("faturamento por empresa e mês", () => {
  it("total de saídas = saídas + prestados; total de entradas = entradas + tomados; números vêm como texto", () => {
    const v = monthView({
      competence: "2026-09",
      saidas: "1250.50",
      entradas: "400",
      prestados: 300,
      tomados: "80",
      notas: 5,
      canceladas: 2,
    });
    assert.deepEqual(v, {
      competence: "2026-09",
      faturamento: 1550.5,
      totalEntradas: 480,
      saidas: 1250.5,
      entradas: 400,
      prestados: 300,
      tomados: 80,
      notas: 5,
      canceladas: 2,
    });
    assert.equal(
      monthView({
        competence: "2026-08",
        saidas: "0.10",
        entradas: 0,
        prestados: "0.20",
        tomados: 0,
        notas: 2,
        canceladas: 0,
      }).faturamento,
      0.3,
    );
  });

  it("mês pedido só vale se está na lista; senão o mais recente", () => {
    const own = [
      {
        competence: "2026-08",
        saidas: 0,
        entradas: 0,
        prestados: 0,
        tomados: 0,
        notas: 1,
        canceladas: 0,
      },
      {
        competence: "2026-09",
        saidas: 0,
        entradas: 0,
        prestados: 0,
        tomados: 0,
        notas: 1,
        canceladas: 0,
      },
      {
        competence: "2026-09",
        saidas: 0,
        entradas: 0,
        prestados: 0,
        tomados: 0,
        notas: 1,
        canceladas: 0,
      },
    ];
    assert.deepEqual(monthsOf(own), ["2026-09", "2026-08"]);
    assert.equal(pickMonth(own, "2026-08"), "2026-08");
    assert.equal(pickMonth(own, "2026-07"), "2026-09");
    assert.equal(pickCompetence(["2026-09"], undefined), "2026-09");
    assert.equal(pickCompetence([], "2026-09"), "");
  });

  it("rótulos", () => {
    assert.equal(monthLabel("2026-09"), "09/2026");
    assert.equal(monthLabel("x"), "x");
    assert.equal(formatBRL(1550.5).replace(/ /g, " "), "R$ 1.550,50");
    assert.equal(formatAmount(48200), "48.200,00");
  });
});

describe("todas as empresas no mês", () => {
  it("uma linha por empresa, maiores saídas primeiro, sem notas por último, e a soma do escritório", () => {
    const m = officeMonth(clients, rows, "2026-09");
    assert.deepEqual(
      m.companies.map((c) => [c.name, c.view?.faturamento ?? null, c.view?.totalEntradas ?? null]),
      [
        ["Padaria Modelo", 48200, 21900],
        ["Clínica Exemplo", 36500, 5300],
        ["Oficina Fictícia", 14300, 9800],
        ["Armazém Teste", null, null],
      ],
    );
    assert.equal(m.withNotes, 3);
    assert.equal(m.withoutNotes, 1);
    assert.deepEqual(m.total, {
      competence: "2026-09",
      faturamento: 99000,
      totalEntradas: 37000,
      saidas: 60500,
      entradas: 35800,
      prestados: 38500,
      tomados: 1200,
      notas: 397,
      canceladas: 1,
    });
  });

  it("ordena por qualquer coluna, nos dois sentidos, e por nome", () => {
    const names = (key: Parameters<typeof officeMonth>[3]) => officeMonth(clients, rows, "2026-09", key).companies.map((c) => c.name);
    assert.deepEqual(names({ key: "totalEntradas", dir: "asc" }), ["Clínica Exemplo", "Oficina Fictícia", "Padaria Modelo", "Armazém Teste"]);
    assert.deepEqual(names({ key: "prestados", dir: "desc" }), ["Clínica Exemplo", "Oficina Fictícia", "Padaria Modelo", "Armazém Teste"]);
    assert.deepEqual(names({ key: "name", dir: "asc" }), ["Clínica Exemplo", "Oficina Fictícia", "Padaria Modelo", "Armazém Teste"]);
    assert.deepEqual(names({ key: "name", dir: "desc" }), ["Padaria Modelo", "Oficina Fictícia", "Clínica Exemplo", "Armazém Teste"]);
  });

  it("mês sem nenhuma nota: todas sem notas e total zerado", () => {
    const m = officeMonth(clients, rows, "2026-07");
    assert.equal(m.withNotes, 0);
    assert.equal(m.withoutNotes, 4);
    assert.equal(m.total.faturamento, 0);
    assert.deepEqual(monthsOf(rows), ["2026-09", "2026-08"]);
  });
});

describe("filtro de lado na tabela de todas", () => {
  const keys = (side: "tudo" | "saidas" | "entradas", parts: boolean) => officeColumns(side, parts).map((c) => c.key);

  it("só saídas e totais, só entradas e totais, ou tudo; a contagem de notas só em tudo", () => {
    assert.deepEqual(keys("tudo", true), ["saidas", "prestados", "faturamento", "entradas", "tomados", "totalEntradas", "notas"]);
    assert.deepEqual(keys("saidas", true), ["saidas", "prestados", "faturamento"]);
    assert.deepEqual(keys("entradas", true), ["entradas", "tomados", "totalEntradas"]);
    assert.deepEqual(keys("tudo", false), ["faturamento", "totalEntradas", "notas"]);
    assert.deepEqual(keys("saidas", false), ["faturamento"]);
    assert.deepEqual(keys("entradas", false), ["totalEntradas"]);
  });

  it("a ordenação acompanha o lado quando a coluna ordenada some", () => {
    assert.deepEqual(sortForSide("entradas", { key: "faturamento", dir: "desc" }), { key: "totalEntradas", dir: "desc" });
    assert.deepEqual(sortForSide("saidas", { key: "tomados", dir: "asc" }), { key: "faturamento", dir: "desc" });
    assert.deepEqual(sortForSide("saidas", { key: "prestados", dir: "asc" }), { key: "prestados", dir: "asc" });
    assert.deepEqual(sortForSide("entradas", { key: "name", dir: "asc" }), { key: "name", dir: "asc" });
    assert.deepEqual(sortForSide("tudo", { key: "notas", dir: "desc" }), { key: "notas", dir: "desc" });
  });
});
