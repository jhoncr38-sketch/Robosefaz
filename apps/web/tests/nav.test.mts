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
  navLocked,
  parseFolderState,
  serializeFolderState,
  type NavFolder,
} from "../src/components/layout/nav-items.ts";

const folders = NAV_GROUPS.flatMap((g) => g.items).filter(isFolder);
const siat = folders.find((f) => f.key === "siat") as NavFolder;

describe("menu lateral", () => {
  it("SIAT agrupa automações, malhas, EFD e fila, nessa ordem", () => {
    assert.equal(siat.label, "Robô");
    assert.deepEqual(
      siat.children.map((c) => c.href),
      ["/automation", "/malhas", "/efd", "/nfse", "/emissao", "/queue"],
    );
  });

  it("função ainda não liberada aparece no menu com cadeado; só a liberada fica sem", () => {
    const emitir = siat.children.find((c) => c.href === "/emissao")!;
    const fila = siat.children.find((c) => c.href === "/queue")!;
    assert.equal(navLocked(emitir, { nfseEmit: "locked" }), true);
    assert.equal(navLocked(emitir, { nfseEmit: "testing" }), true, "o dono entra, mas vê o cadeado como os demais");
    assert.equal(navLocked(emitir, { nfseEmit: "on" }), false);
    assert.equal(navLocked(emitir, undefined), true);
    assert.equal(navLocked(fila, { nfseEmit: "locked" }), false, "item sem função própria nunca tem cadeado");
  });

  it("NFS-e Nacional e Faturamento levam a etiqueta Novo (e só elas)", () => {
    assert.deepEqual(NAV_ITEMS.filter((i) => i.isNew).map((i) => i.href), ["/nfse", "/faturamento"]);
  });

  it("Operação do dia e Escritórios são só do dono da plataforma", () => {
    assert.deepEqual(NAV_ITEMS.filter((i) => i.ownerOnly).map((i) => i.href), ["/operation", "/organizations"]);
  });

  it("Resultados, Empresas e Administração também recolhem, como o SIAT", () => {
    const byKey = Object.fromEntries(folders.map((f) => [f.key, f.children.map((c) => c.href)]));
    assert.deepEqual(byKey.resultados, ["/downloads", "/notes", "/faturamento", "/history"]);
    assert.deepEqual(byKey.empresas, ["/clients", "/certificates", "/organizations"]);
    assert.deepEqual(byKey.admin, ["/users", "/devices", "/settings"]);
    assert.equal(new Set(folders.map((f) => f.key)).size, folders.length);
  });

  it("todas as páginas continuam no menu (inclusive as de dentro do SIAT)", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    for (const href of ["/dashboard", "/operation", "/automation", "/malhas", "/efd", "/nfse", "/emissao", "/queue", "/downloads", "/notes", "/faturamento", "/history", "/clients", "/certificates", "/organizations", "/users", "/devices", "/settings"]) {
      assert.ok(hrefs.includes(href), href);
    }
    assert.equal(new Set(hrefs).size, hrefs.length);
  });

  it("breadcrumb: páginas de um grupo aparecem como Grupo › página", () => {
    assert.deepEqual(navLocation("/malhas"), { group: "Robô", label: "Consulta de Malhas" });
    assert.deepEqual(navLocation("/queue/123"), { group: "Robô", label: "Fila de processamento" });
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
