// Emissão de NFS-e no painel: tomadores, serviços e nota-modelo a partir do índice; situação de cada
// emissão; DANFSe no modelo nacional (Nota Técnica nº 008/2026). Empresas e notas fictícias.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { danfseNacionalHtml } from "../src/lib/danfse-nacional.ts";
import {
  buildEmitProfile,
  checkDraft,
  clientNotice,
  type Emission,
  emissionState,
  emissionSteps,
  type EmitNote,
  explainRejection,
  formatDoc,
  formatServiceCode,
  monthSummary,
  parseAmount,
  checkCodes,
  emitAccess,
  NFSE_EMIT_RELEASED,
  formatNbs,
  pickBaseModel,
  pickModel,
  takerNoteKey,
} from "../src/lib/nfse-emit.ts";

const SOL = "55666777000188";
const MERCADO = "99888777000155";
const key = (n: number) => `2211001121122233300018100000000${String(n).padStart(5, "0")}26090000000017`;

function note(n: number, over: Partial<EmitNote> = {}): EmitNote {
  return {
    chave: key(n),
    numero: n,
    emitida_em: `2026-09-${String(n).padStart(2, "0")}T10:00:00-03:00`,
    valor: 1200,
    dest_doc: SOL,
    dest_nome: "Condomínio Sol",
    servico: "Manutenção preventiva",
    c_trib_nac: "140101",
    c_trib_mun: "040",
    servico_nome: "Manutenção de ar-condicionado",
    emit_model: "ok",
    canceled: false,
    ...over,
  };
}

const NOTES: EmitNote[] = [
  note(1),
  note(5, { valor: 1300 }),
  note(3, { dest_doc: MERCADO, dest_nome: "Mercado Bom Preço", c_trib_nac: "140601", c_trib_mun: "009", servico_nome: "Instalação", valor: 2400, emit_model: "mesmo_tomador" }),
  note(4, { emit_model: "fora_simples" }),
  note(6, { canceled: true, valor: 9999 }),
  note(7, { dest_doc: null, dest_nome: null, valor: 80 }),
  note(2, { emit_model: null, c_trib_mun: null }),
];

describe("emissão de NFS-e: o que a tela tira do índice", () => {
  it("monta tomadores, serviços e últimas notas só com as notas que servem de modelo", () => {
    const p = buildEmitProfile(NOTES);
    assert.equal(p.usable, 4);
    assert.deepEqual(p.takers.map((t) => [t.nome, t.notas, t.ultima.numero, t.ultima.valor]), [
      ["Condomínio Sol", 2, 5, 1300],
      ["Mercado Bom Preço", 1, 3, 2400],
    ]);
    assert.deepEqual(p.services.map((s) => [s.id, s.codigo, s.notas, s.livre]), [
      ["140101|040", "14.01.01 / 040", 3, true],
      ["140601|009", "14.06.01 / 009", 1, false],
    ]);
    assert.deepEqual(p.recent.map((n) => n.numero), [7, 5, 3, 1]);
    assert.equal(buildEmitProfile([note(1, { emit_model: "fora_simples" })]).blocked, "a empresa está fora do Simples Nacional (ME/EPP)");
  });

  it("escolhe a nota-modelo: a do mesmo tomador; senão, uma que valha para qualquer tomador", () => {
    assert.deepEqual(pickModel(NOTES, "140101|040", SOL), { ok: true, chave: key(5), sameTaker: true });
    assert.deepEqual(pickModel(NOTES, "140101|040", MERCADO), { ok: true, chave: key(7), sameTaker: false });
    assert.deepEqual(pickModel(NOTES, "140101|040", null), { ok: true, chave: key(7), sameTaker: false });
    // obra ou ISS retido: só para o tomador da própria nota
    assert.deepEqual(pickModel(NOTES, "140601|009", MERCADO), { ok: true, chave: key(3), sameTaker: true });
    const other = pickModel(NOTES, "140601|009", SOL);
    assert.equal(other.ok, false);
    assert.match(other.ok ? "" : other.error, /só dá para repetir/);
    assert.equal(pickModel(NOTES, "999999|001", SOL).ok, false);
    // a nota cancelada nunca é modelo nem fonte do tomador
    assert.equal(takerNoteKey(NOTES, SOL), key(5));
    assert.equal(takerNoteKey(NOTES, "00000000000000"), null);
  });

  it("sugere o NBS e o IBS/CBS da nota mais recente e confere os códigos digitados", () => {
    const notes = [
      note(8, { c_nbs: "101061200", ibs_cst: "200", ibs_class_trib: "200052", ibs_ind_op: "100301" }),
      note(2, { c_nbs: "118032900" }),
      note(3, { c_trib_nac: "140601", c_trib_mun: "009", servico_nome: "Instalação", emit_model: "mesmo_tomador" }),
    ];
    const p = buildEmitProfile(notes);
    assert.deepEqual([p.services[0].nbs, p.services[0].ibs], ["101061200", { cst: "200", classTrib: "200052", indOp: "100301" }]);
    assert.deepEqual([p.services[1].nbs, p.services[1].ibs], ["", null]);
    assert.deepEqual([p.recent[0].nbs, p.recent[0].ibs?.classTrib, p.takers[0].ultima.nbs], ["101061200", "200052", "101061200"]);
    // outra atividade do cadastro: a base é a nota comum mais recente (nunca uma de obra ou ISS retido)
    assert.deepEqual(pickBaseModel(notes), { ok: true, chave: key(8), sameTaker: false });
    assert.equal(pickBaseModel([notes[2]]).ok, false);
    const ok = { custom: false, nac: "", mun: "", nbs: "", cst: "", classTrib: "", indOp: "" };
    assert.deepEqual(checkCodes(ok), []);
    assert.deepEqual(checkCodes({ ...ok, custom: true, nac: "14.06.01", mun: "009", nbs: "1.0106.12.00", cst: "000", classTrib: "000001", indOp: "050101" }), []);
    assert.match(checkCodes({ ...ok, custom: true, nac: "1406", mun: "9" })[0], /código nacional/);
    assert.match(checkCodes({ ...ok, nbs: "123" })[0], /NBS tem 9/);
    assert.match(checkCodes({ ...ok, classTrib: "000001" })[0], /IBS\/CBS/);
    // escolhendo nas listas oficiais, o aviso fala em escolher (a situação tributária sai sozinha da classificação)
    assert.match(checkCodes({ ...ok, lists: true, cst: "000", classTrib: "000001" })[0], /escolha também o indicador da operação/);
    assert.match(checkCodes({ ...ok, lists: true, custom: true, nac: "140601", mun: "" })[0], /escolha o código de tributação nacional/);
    assert.deepEqual(checkCodes({ ...ok, lists: true, custom: true, nac: "140601", mun: "009", cst: "000", classTrib: "000001", indOp: "050102" }), []);
    assert.deepEqual([formatNbs("101061200"), formatNbs(""), formatNbs(null)], ["1.0106.12.00", "", ""]);
  });

  it("lê o valor digitado e avisa o que mudou em relação à última nota do tomador", () => {
    assert.deepEqual(["1.500,00", "1500", "R$ 1.500", "1.500", "15,5", "abc", "0", ""].map(parseAmount), [1500, 1500, 1500, 1500, 15.5, null, null, null]);
    const sol = buildEmitProfile(NOTES).takers[0];
    const same = checkDraft(1300, "140101|040", sol, false);
    assert.deepEqual([same.amountDiff, same.serviceChanged, same.warnings], [null, false, []]);
    const changed = checkDraft(1625, "140601|009", sol, false);
    assert.deepEqual([changed.amountDiff, changed.serviceChanged], [25, true]);
    assert.match(changed.warnings[0], /25% maior/);
    assert.match(checkDraft(100, "140101|040", null, true).warnings[0], /Tomador novo/);
    assert.equal(formatServiceCode("140101|040"), "14.01.01 / 040");
    assert.deepEqual([formatDoc(SOL), formatDoc("12345678901"), formatDoc("")], ["55.666.777/0001-88", "123.456.789-01", ""]);
  });
});

function emission(over: Partial<Emission> = {}): Emission {
  return {
    id: "e1",
    client_id: "c1",
    created_by: null,
    created_at: "2026-10-10T15:00:00Z",
    test_env: false,
    source: "ai",
    request_text: null,
    toma_doc: SOL,
    toma_nome: "Condomínio Sol",
    c_trib_nac: "140101",
    c_trib_mun: "040",
    servico_nome: "Manutenção",
    description: "Manutenção do ar",
    amount: 1500,
    competence: "2026-10",
    status: "queued",
    job_id: "j1",
    n_dps: null,
    send_started_at: null,
    chave: null,
    numero: null,
    issued_at: null,
    errors: [],
    last_message: null,
    steps: {},
    cancel_status: null,
    cancel_job_id: null,
    cancel_reason: null,
    cancel_errors: [],
    canceled_at: null,
    ...over,
  };
}

describe("emissão de NFS-e: situação e andamento", () => {
  it("diz a situação de cada emissão; envio sem confirmação pede conferência", () => {
    const of = (o: Partial<Emission>) => emissionState(emission(o));
    assert.deepEqual([of({}).label, of({}).running], ["Na fila do robô", true]);
    assert.equal(of({ status: "processing" }).label, "Emitindo");
    assert.deepEqual([of({ status: "issued" }).label, of({ status: "issued" }).tone], ["Emitida", "green"]);
    assert.deepEqual([of({ status: "issued", cancel_status: "requested" }).label, of({ status: "issued", cancel_status: "requested" }).running], ["Cancelando", true]);
    assert.equal(of({ status: "issued", cancel_status: "rejected" }).label, "Emitida");
    assert.equal(of({ status: "canceled" }).label, "Cancelada");
    assert.equal(of({ status: "rejected" }).label, "Recusada pela prefeitura");
    assert.deepEqual([of({ status: "failed" }).label, of({ status: "failed" }).uncertain], ["Não emitida", false]);
    const lost = of({ status: "failed", send_started_at: "2026-10-10T15:01:00Z" });
    assert.deepEqual([lost.label, lost.uncertain, lost.tone], ["Confira na prefeitura", true, "amber"]);
  });

  it("mostra o andamento em quatro passos, parando onde a nota parou", () => {
    const states = (o: Partial<Emission>) => emissionSteps(emission(o)).map((s) => s.state);
    assert.deepEqual(states({}), ["now", "todo", "todo", "todo"]);
    assert.deepEqual(states({ status: "processing", steps: { started_at: "a", signed_at: "b" } }), ["done", "done", "now", "todo"]);
    assert.deepEqual(states({ status: "issued", numero: 128, steps: { started_at: "a", signed_at: "b", sent_at: "c", issued_at: "d" } }), ["done", "done", "done", "done"]);
    assert.deepEqual(states({ status: "rejected", steps: { started_at: "a", signed_at: "b", sent_at: "c" } }), ["done", "done", "done", "todo"]);
    assert.equal(emissionSteps(emission({ status: "issued", numero: 128 }))[3].hint, "NFS-e nº 128");
  });

  it("explica as recusas conhecidas, monta o aviso para o cliente e soma o mês", () => {
    assert.match(explainRejection({ codigo: "L0001", mensagem: "x" }), /não consta no cadastro/);
    assert.match(explainRejection({ codigo: "L9999", mensagem: "Configuração Atividade NÃO localizada" }), /não tem este serviço configurado/);
    assert.equal(explainRejection({ codigo: "E1", mensagem: "outra coisa" }), "");
    const text = clientNotice(emission({ numero: 128, chave: key(128) }));
    assert.match(text, /nº 128 para Condomínio Sol, no valor de R\$\s1\.500,00/);
    assert.ok(text.includes(`https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${key(128)}`));
    const sum = monthSummary(
      [emission({ status: "issued" }), emission({ status: "issued", amount: "500.50" }), emission({ status: "canceled", amount: 300 }), emission({ status: "rejected" }),
       emission({ status: "issued", test_env: true }), emission({ status: "issued", created_at: "2026-09-30T10:00:00Z" })],
      "2026-10",
    );
    assert.deepEqual(sum, { issued: 2, issuedTotal: 2000.5, canceled: 1, canceledTotal: 300, refused: 1 });
  });
});

const CHAVE = key(128);
const NFSE = `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${CHAVE}">
<xLocEmi>TERESINA</xLocEmi><xLocPrestacao>TERESINA</xLocPrestacao><nNFSe>128</nNFSe><cLocIncid>2211001</cLocIncid><xLocIncid>TERESINA</xLocIncid>
<xTribNac>Lubrificação, limpeza e revisão.</xTribNac><xTribMun>MANUTENCAO DE AR-CONDICIONADO</xTribMun><ambGer>1</ambGer><tpEmis>2</tpEmis><cStat>100</cStat>
<dhProc>2026-10-10T22:48:24-03:00</dhProc><emit><CNPJ>11222333000181</CNPJ><IM>1234567</IM><xNome>CLIMA FRIO &amp; CIA LTDA</xNome>
<enderNac><xLgr>RUA A</xLgr><nro>10</nro><xBairro>CENTRO</xBairro><cMun>2211001</cMun><UF>PI</UF><CEP>64000000</CEP></enderNac><email>contato@clima.test</email></emit>
<valores><vBC>0.00</vBC><vLiq>1500.00</vLiq></valores><DPS versao="1.01"><infDPS Id="DPS221100121122233300018110001000000000000001"><tpAmb>TPAMB</tpAmb>
<dhEmi>2026-10-10T22:46:12-03:00</dhEmi><serie>10001</serie><nDPS>1</nDPS><dCompet>2026-10-01</dCompet><tpEmit>1</tpEmit><cLocEmi>2211001</cLocEmi>
<prest><CNPJ>11222333000181</CNPJ><IM>1234567</IM><regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest>TOMA
<serv><locPrest><cLocPrestacao>2211001</cLocPrestacao></locPrest><cServ><cTribNac>140101</cTribNac><cTribMun>040</cTribMun>
<xDescServ>Manutenção do ar &lt;salão&gt;</xDescServ><cNBS>101061200</cNBS></cServ></serv>
<valores><vServPrest><vServ>1500.00</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun><totTrib><indTotTrib>0</indTotTrib></totTrib></trib></valores>
</infDPS></DPS></infNFSe></NFSe>`;
const TOMA = `<toma><CNPJ>${SOL}</CNPJ><xNome>CONDOMINIO SOL</xNome><end><endNac><cMun>3550308</cMun><CEP>01001000</CEP></endNac><xLgr>RUA B</xLgr><nro>20</nro><xBairro>SE</xBairro></end></toma>`;
const nfse = (tpAmb: string, toma = TOMA) => NFSE.replace("TPAMB", tpAmb).replace("TOMA", toma);

describe("DANFSe no modelo nacional (NT 008/2026)", () => {
  it("traz os blocos do modelo na ordem, com os dados do XML e o nome dos municípios", () => {
    const html = danfseNacionalHtml(nfse("1"), { logoUrl: "https://painel.test/nfse-logo.png" }) ?? "";
    assert.ok(html.includes("<div>DANFSe v2.0</div><div>Documento Auxiliar da NFS-e</div>"));
    const order = ["PRESTADOR / FORNECEDOR", "TOMADOR / ADQUIRENTE", "DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO", "INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO",
                   "SERVIÇO PRESTADO", "TRIBUTAÇÃO MUNICIPAL (ISSQN)", "TRIBUTAÇÃO FEDERAL (EXCETO CBS)", "TRIBUTAÇÃO IBS / CBS", "VALOR TOTAL DA NFS-E", "INFORMAÇÕES COMPLEMENTARES"];
    const positions = order.map((t) => html.indexOf(t));
    assert.ok(positions.every((p) => p > 0), JSON.stringify(positions));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.ok(html.includes(`<b>${CHAVE}</b>`) && html.includes("<b>10/10/2026 22:48:24</b>") && html.includes("<b>01/10/2026</b>"));
    assert.ok(html.includes("Município: Teresina / PI") && html.includes("Ambiente Gerador: Prefeitura") && html.includes("Tipo de Ambiente: Produção"));
    // prestador vem do grupo emit; os textos do XML são protegidos; município pelo código IBGE
    assert.ok(html.includes("CLIMA FRIO &amp; CIA LTDA") && html.includes("11.222.333/0001-81") && html.includes("2211001 / 64.000-000"));
    assert.ok(html.includes("São Paulo / SP") && html.includes("55.666.777/0001-88"));
    assert.ok(html.includes("14.01.01 / 040") && html.includes("1.0106.12.00") && html.includes("Teresina / PI / BR"));
    assert.ok(html.includes("Manutenção do ar &lt;salão&gt;") && html.includes("MANUTENCAO DE AR-CONDICIONADO"));
    // descrições longas são cortadas com reticências no tamanho que a nota técnica indica para o campo
    assert.ok(html.includes("Optante - Microempresa ou Empresa de...") && html.includes("Operação Tributável") && html.includes("Não Retido"));
    assert.match(html, /R\$\s1\.500,00/);
    assert.ok(html.includes("Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: Federais: -; Estaduais: -; Municipais: -"));
    // QR Code da consulta pública, logotipo e nada de aviso de teste ou marca-d'água numa nota normal
    assert.ok(html.includes('<svg class="qr"') && html.includes('src="https://painel.test/nfse-logo.png"'));
    assert.ok(!html.includes("SEM VALIDADE JURÍDICA") && !html.includes('class="marca"'));
  });

  it("marca a nota de teste, a cancelada e a sem tomador como a nota técnica manda", () => {
    const test = danfseNacionalHtml(nfse("2"), { cancelada: true }) ?? "";
    assert.ok(test.includes('<div class="sv">NFS-e SEM VALIDADE JURÍDICA</div>') && test.includes("Tipo de Ambiente: Homologação"));
    assert.ok(test.includes('<div class="marca">CANCELADA</div>'));
    assert.ok((danfseNacionalHtml(nfse("1"), { substituida: true }) ?? "").includes('<div class="marca">SUBSTITUÍDA</div>'));
    const semTomador = danfseNacionalHtml(nfse("1", "")) ?? "";
    assert.ok(semTomador.includes("TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e") && !semTomador.includes("TOMADOR / ADQUIRENTE"));
    assert.equal(danfseNacionalHtml("<nfeProc/>"), null);
  });
});

describe("quem entra na emissão", () => {
  it("antes do lançamento só o dono da plataforma entra, mesmo com o escritório ligado", () => {
    assert.equal(emitAccess({ released: false, officeEnabled: true, isOwner: false }), "locked");
    assert.equal(emitAccess({ released: false, officeEnabled: false, isOwner: false }), "locked");
    assert.equal(emitAccess({ released: false, officeEnabled: true, isOwner: true }), "testing");
    assert.equal(emitAccess({ released: false, officeEnabled: false, isOwner: true }), "testing");
  });

  it("depois do lançamento vale o liga/desliga do escritório; o dono sempre entra", () => {
    assert.equal(emitAccess({ released: true, officeEnabled: true, isOwner: false }), "on");
    assert.equal(emitAccess({ released: true, officeEnabled: false, isOwner: false }), "locked");
    assert.equal(emitAccess({ released: true, officeEnabled: false, isOwner: true }), "on");
  });

  it("a função segue travada até alguém decidir lançar", () => {
    assert.equal(NFSE_EMIT_RELEASED, false);
  });
});
