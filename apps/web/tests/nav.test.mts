// Menu lateral: submenu SIAT, contadores e breadcrumb do cabeçalho.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NAV_GROUPS,
  NAV_ITEMS,
  folderBadge,
  isActive,
  isFolder,
  navLocation,
  parseFolderState,
  serializeFolderState,
  type NavFolder,
} from "../src/components/layout/nav-items.ts";

const folders = NAV_GROUPS.flatMap((g) => g.items).filter(isFolder);
const siat = folders.find((f) => f.key === "siat") as NavFolder;

describe("menu lateral", () => {
  it("SIAT agrupa automações, malhas, EFD e fila, nessa ordem", () => {
    assert.equal(siat.label, "SIAT");
    assert.deepEqual(
      siat.children.map((c) => c.href),
      ["/automation", "/malhas", "/efd", "/queue"],
    );
  });

  it("Resultados, Empresas e Administração também recolhem, como o SIAT", () => {
    const byKey = Object.fromEntries(folders.map((f) => [f.key, f.children.map((c) => c.href)]));
    assert.deepEqual(byKey.resultados, ["/downloads", "/notes", "/history", "/errors"]);
    assert.deepEqual(byKey.empresas, ["/clients", "/certificates", "/organizations"]);
    assert.deepEqual(byKey.admin, ["/users", "/devices", "/settings"]);
    assert.equal(new Set(folders.map((f) => f.key)).size, folders.length);
  });

  it("todas as páginas continuam no menu (inclusive as de dentro do SIAT)", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    for (const href of ["/dashboard", "/automation", "/malhas", "/efd", "/queue", "/downloads", "/notes", "/history", "/errors", "/clients", "/certificates", "/organizations", "/users", "/devices", "/settings"]) {
      assert.ok(hrefs.includes(href), href);
    }
    assert.equal(new Set(hrefs).size, hrefs.length);
  });

  it("breadcrumb: páginas de um grupo aparecem como Grupo › página", () => {
    assert.deepEqual(navLocation("/malhas"), { group: "SIAT", label: "Consulta de Malhas" });
    assert.deepEqual(navLocation("/queue/123"), { group: "SIAT", label: "Fila de processamento" });
    assert.deepEqual(navLocation("/downloads"), { group: "Resultados", label: "Downloads" });
    assert.deepEqual(navLocation("/clients/abc"), { group: "Empresas", label: "Clientes" });
    assert.deepEqual(navLocation("/devices"), { group: "Administração", label: "Computadores" });
    assert.equal(navLocation("/nada"), null);
  });

  it("isActive não confunde prefixos parecidos", () => {
    assert.ok(isActive("/efd", "/efd"));
    assert.ok(isActive("/efd", "/efd/x"));
    assert.ok(!isActive("/efd", "/efdx"));
  });

  it("SIAT fechado mostra a soma dos contadores, em amarelo se a fila tem serviço", () => {
    assert.deepEqual(folderBadge(siat, { queue: 3, downloads: 146, clients: 22 }), { value: 3, warn: true });
    assert.deepEqual(folderBadge(siat, { queue: 0, downloads: 146, clients: 22 }), { value: 0, warn: false });
    assert.deepEqual(folderBadge(siat), { value: 0, warn: false });
  });

  it("cookie guarda só as escolhas feitas (aberto/fechado) e ignora lixo", () => {
    assert.deepEqual(parseFolderState("siat:1,resultados:0"), { siat: true, resultados: false });
    assert.deepEqual(parseFolderState(" siat:1 , ,<x>:1,empresas:2,resultados"), { siat: true });
    assert.deepEqual(parseFolderState(undefined), {});
    assert.equal(serializeFolderState({ siat: true, empresas: false }), "siat:1,empresas:0");
    assert.deepEqual(parseFolderState(serializeFolderState({ resultados: false })), { resultados: false });
  });
});
