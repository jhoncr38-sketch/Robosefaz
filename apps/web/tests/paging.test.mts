// "Carregar mais": lotes na URL e a janela dos mais recentes de duas listas.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { moreHref, newest, parseShown, SHOW_MAX } from "../src/lib/paging.ts";

describe("carregar mais", () => {
  it("quantas linhas mostrar", () => {
    assert.equal(parseShown(undefined, 500), 500);
    assert.equal(parseShown("1000", 500), 1000);
    assert.equal(parseShown("700", 500), 1000); // arredonda para o lote
    assert.equal(parseShown("abc", 500), 500);
    assert.equal(parseShown("-3", 500), 500);
    assert.equal(parseShown("999999", 500), SHOW_MAX);
  });

  it("o link mantém os filtros e soma um lote", () => {
    assert.equal(
      moreHref("/downloads", { competence: "2026-09", client: undefined, mostrar: "500" }, 500, 500),
      "/downloads?competence=2026-09&mostrar=1000",
    );
    assert.equal(moreHref("/history", {}, 300, 300), "/history?mostrar=600");
  });

  it("junta duas listas pela data e corta nos mais recentes", () => {
    const files = ["2026-10-01", "2026-09-28", "2026-09-01"];
    const empty = ["2026-09-30", "2026-08-15"];
    const w = newest(files, empty, (x) => x, (x) => x, 3);
    assert.deepEqual(w, { a: ["2026-10-01", "2026-09-28"], b: ["2026-09-30"] });
    assert.deepEqual(newest(files, empty, (x) => x, (x) => x, 10), { a: files, b: empty });
  });
});
