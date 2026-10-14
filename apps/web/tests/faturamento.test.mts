// Resultados › Faturamento: a linha do banco vira o que a tela mostra. Valores fictícios.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatBRL, monthLabel, monthView, pickMonth } from "../src/lib/faturamento.ts";

describe("faturamento por empresa e mês", () => {
  it("faturamento = saídas + serviços prestados; números vêm como texto do banco", () => {
    const v = monthView({ competence: "2026-09", saidas: "1250.50", entradas: "400", prestados: 300, tomados: "80", notas: 5, canceladas: 2 });
    assert.deepEqual(v, { competence: "2026-09", faturamento: 1550.5, saidas: 1250.5, entradas: 400, prestados: 300, tomados: 80, notas: 5, canceladas: 2 });
    assert.equal(monthView({ competence: "2026-08", saidas: "0.10", entradas: 0, prestados: "0.20", tomados: 0, notas: 2, canceladas: 0 }).faturamento, 0.3);
  });

  it("mês pedido só vale se a empresa tem notas nele; senão o mais recente", () => {
    const rows = [
      { competence: "2026-09", saidas: 0, entradas: 0, prestados: 0, tomados: 0, notas: 1, canceladas: 0 },
      { competence: "2026-08", saidas: 0, entradas: 0, prestados: 0, tomados: 0, notas: 1, canceladas: 0 },
    ];
    assert.equal(pickMonth(rows, "2026-08"), "2026-08");
    assert.equal(pickMonth(rows, "2026-07"), "2026-09");
    assert.equal(pickMonth(rows, undefined), "2026-09");
    assert.equal(pickMonth([], "2026-09"), "");
  });

  it("rótulos", () => {
    assert.equal(monthLabel("2026-09"), "09/2026");
    assert.equal(monthLabel("x"), "x");
    assert.equal(formatBRL(1550.5).replace(/ /g, " "), "R$ 1.550,50");
  });
});
