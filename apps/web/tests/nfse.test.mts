// NFS-e Nacional no painel: situação na tela NFS-e, leitura da DANFSe, busca pela chave de 50 números.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDanfse } from "../src/lib/danfse.ts";
import { blockKey, typeFilterFromDoc } from "../src/lib/downloads-month.ts";
import { parseNoteQuery } from "../src/lib/nfe-key.ts";
import { type NfseCursor, type NfseJob, nfseHint, nfseRowState } from "../src/lib/nfse.ts";
import { counterparty, isNfse, noteKind } from "../src/lib/notes.ts";

const KEY = "22110011211222333000181000000000000126090000000017";
const CLIENT = "11222333000181";
const OTHER = "99888777000155";

function xml(prest: string, toma: string, ret = "1"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infNFSe Id="NFS${KEY}">
<xLocEmi>Teresina</xLocEmi><xLocPrestacao>Teresina</xLocPrestacao><nNFSe>12</nNFSe><xLocIncid>Teresina</xLocIncid>
<xTribNac>Consultoria e assessoria</xTribNac><cStat>100</cStat><dhProc>2026-09-15T10:00:00-03:00</dhProc>
<emit><CNPJ>${prest}</CNPJ><IM>123</IM><xNome>PRESTADORA FICTICIA LTDA</xNome><enderNac><xLgr>Rua A</xLgr><nro>10</nro><xBairro>Centro</xBairro><cMun>2211001</cMun><UF>PI</UF><CEP>64000000</CEP></enderNac></emit>
<valores><vBC>1500.00</vBC><pAliqAplic>5.00</pAliqAplic><vISSQN>75.00</vISSQN><vTotalRet>0.00</vTotalRet><vLiq>1500.00</vLiq></valores>
<DPS versao="1.00"><infDPS Id="DPS1"><dhEmi>2026-09-15T09:00:00-03:00</dhEmi><serie>900</serie><nDPS>12</nDPS><dCompet>2026-09-15</dCompet>
<prest><CNPJ>${prest}</CNPJ><regTrib><opSimpNac>3</opSimpNac></regTrib></prest>
<toma><CNPJ>${toma}</CNPJ><xNome>TOMADORA FICTICIA</xNome><end><endNac><cMun>2211001</cMun><CEP>64001000</CEP></endNac><xLgr>Rua B</xLgr><nro>2</nro><xBairro>Fátima</xBairro></end></toma>
<serv><cServ><cTribNac>171401</cTribNac><xDescServ>Servico ficticio</xDescServ></cServ></serv>
<valores><vServPrest><vServ>1500.00</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>${ret}</tpRetISSQN></tribMun></trib></valores>
</infDPS></DPS></infNFSe></NFSe>`;
}

const job = (extra: Partial<NfseJob>): NfseJob => ({
  id: "j1",
  client_id: "c1",
  status: "completed",
  created_at: "2026-10-09T20:00:00Z",
  finished_at: "2026-10-09T20:01:00Z",
  last_message: "NFS-e: 2 tomada(s) nova(s).",
  error_message: null,
  ...extra,
});
const cursor: NfseCursor = { client_id: "c1", last_nsu: 14, fetched_at: "2026-10-09T20:01:00Z", last_documents: 13 };

describe("tela NFS-e Nacional", () => {
  it("situação de cada cliente", () => {
    assert.equal(nfseRowState(undefined, undefined), "never");
    assert.equal(nfseRowState(undefined, job({ status: "queued" })), "fetching");
    assert.equal(nfseRowState(cursor, job({ status: "checking_processing" })), "fetching");
    assert.equal(nfseRowState(cursor, job({ status: "failed", error_message: "API fora do ar" })), "error");
    assert.equal(nfseRowState(undefined, job({ status: "certificate_required" })), "error");
    assert.equal(nfseRowState(cursor, job({})), "done");
    assert.equal(nfseHint("done", job({})), "NFS-e: 2 tomada(s) nova(s).");
    assert.equal(nfseHint("fetching", job({ status: "queued" })), "Na fila do robô");
    assert.equal(nfseHint("error", job({ status: "failed", error_message: "API fora do ar" })), "API fora do ar");
  });
});

describe("DANFSe", () => {
  it("lê prestador, tomador, serviço e ISS do XML", () => {
    const d = parseDanfse(xml(CLIENT, OTHER, "2"));
    assert.ok(d);
    assert.equal(d.chave, KEY);
    assert.deepEqual([d.numero, d.serieDps, d.numeroDps, d.competencia], ["12", "900", "12", "2026-09-15"]);
    assert.equal(d.prestador.nome, "PRESTADORA FICTICIA LTDA");
    assert.equal(d.prestador.municipio, "Teresina"); // o código IBGE vira o nome do local de emissão
    assert.equal(d.prestador.uf, "PI");
    assert.equal(d.tomador?.nome, "TOMADORA FICTICIA");
    assert.equal(d.tomador?.municipio, ""); // só código IBGE: não mostra
    assert.equal(d.tomador?.cep, "64001000");
    assert.equal(d.simples, "Optante pelo Simples Nacional (ME/EPP)");
    assert.equal(d.servico.descricao, "Servico ficticio");
    assert.deepEqual([d.valores.servico, d.valores.aliquota, d.valores.iss, d.valores.issRetido], ["1500.00", "5.00", "75.00", true]);
    assert.equal(parseDanfse("<nfeProc/>"), null);
  });
});

describe("busca e índice com NFS-e", () => {
  it("chave de 50 números é chave; 44 continua valendo", () => {
    assert.deepEqual(parseNoteQuery(KEY), { kind: "chave", value: KEY });
    assert.deepEqual(parseNoteQuery("2226 0837 3548 6000 0133 5522 6000 0000 0318 2024 4645"), {
      kind: "chave",
      value: "22260837354860000133552260000000031820244645",
    });
    assert.equal(parseNoteQuery("1".repeat(47))?.kind, "nome");
  });

  it("tipo e outra parte da nota de serviço", () => {
    const clients = { client_code: "CLI000001", legal_name: "Empresa A", trade_name: null, cnpj: CLIENT };
    const prestada = { document_type: "NFSE_PRESTADAS" as const, canceled: false, emit_doc: CLIENT, emit_nome: "A", dest_doc: OTHER, dest_nome: "B", clients };
    const tomada = { ...prestada, document_type: "NFSE_TOMADAS" as const, canceled: true, emit_doc: OTHER, emit_nome: "B", dest_doc: CLIENT, dest_nome: "A" };
    assert.ok(isNfse(prestada) && isNfse(tomada));
    assert.deepEqual(noteKind(prestada), { label: "NFS-e prestada", canceled: false });
    assert.deepEqual(noteKind(tomada), { label: "NFS-e tomada", canceled: true });
    assert.equal(counterparty(prestada).role, "Tomador");
    assert.equal(counterparty(tomada).role, "Prestador");
  });

  it("chip NFS-e em Downloads", () => {
    assert.equal(blockKey("NFSE_PRESTADAS"), "nfse");
    assert.equal(blockKey("NFSE_TOMADAS"), "nfse");
    assert.equal(typeFilterFromDoc("nfse"), "nfse");
    assert.equal(typeFilterFromDoc("NFSE_TOMADAS"), "nfse");
    assert.equal(typeFilterFromDoc("NFE_EMITIDAS"), "emit");
    assert.equal(typeFilterFromDoc("xyz"), "all");
  });
});
