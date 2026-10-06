// Tela Notas: chave de acesso, o que a pessoa digitou e a leitura do XML para a DANFE.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDoc, formatMoney, formatNoteNumber, parseDanfe } from "../src/lib/danfe.ts";
import { formatKey, isValidKey, keyParts, parseNoteQuery } from "../src/lib/nfe-key.ts";

const KEY = "22260837354860000133552260000000031820244645"; // chave real de uma NF-e do Piauí

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${KEY}" versao="4.00">
<ide><cUF>22</cUF><natOp>VENDA DE MERCADORIA</natOp><mod>55</mod><serie>226</serie><nNF>3</nNF><dhEmi>2026-08-03T08:08:48-03:00</dhEmi><tpNF>1</tpNF></ide>
<emit><CNPJ>37354860000133</CNPJ><xNome>Ana &amp; Cia</xNome><enderEmit><xLgr>Av. Frei Serafim</xLgr><nro>1234</nro><xBairro>Centro</xBairro><xMun>Teresina</xMun><UF>PI</UF><CEP>64001020</CEP><fone>8632220000</fone></enderEmit><IE>196677149</IE></emit>
<dest><CPF>03077247437</CPF><xNome>Henrique Diniz</xNome><enderDest><xMun>Campina Grande</xMun><UF>PB</UF></enderDest></dest>
<det nItem="1"><prod><cProd>000412</cProd><xProd>REFRIGERANTE COLA 2L</xProd><NCM>22021000</NCM><CFOP>5102</CFOP><uCom>CX</uCom><qCom>60.0000</qCom><vUnCom>38.00</vUnCom><vProd>2280.00</vProd></prod>
<imposto><ICMS><ICMS00><orig>0</orig><CST>00</CST><pICMS>18.00</pICMS></ICMS00></ICMS></imposto></det>
<det nItem="2"><prod><cProd>000587</cProd><xProd>AGUA MINERAL</xProd><NCM>22011000</NCM><CFOP>5102</CFOP><uCom>FD</uCom><qCom>80.0000</qCom><vUnCom>14.50</vUnCom><vProd>1160.00</vProd></prod>
<imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto></det>
<total><ICMSTot><vBC>4400.00</vBC><vICMS>792.00</vICMS><vBCST>0.00</vBCST><vST>0.00</vST><vProd>3440.00</vProd><vFrete>320.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vOutro>117.50</vOutro><vIPI>0.00</vIPI><vNF>3877.50</vNF><vTotTrib>1164.30</vTotTrib></ICMSTot></total>
<transp><transporta><xNome>TRANSPI LOG</xNome></transporta></transp>
<infAdic><infCpl>Pedido 7781.</infCpl></infAdic>
</infNFe></NFe><protNFe><infProt><nProt>222260019563855</nProt><dhRecbto>2026-08-03T08:08:50-03:00</dhRecbto><cStat>100</cStat></infProt></protNFe></nfeProc>`;

describe("chave de acesso", () => {
  it("valida o dígito verificador e separa as partes", () => {
    assert.ok(isValidKey(KEY));
    assert.ok(isValidKey(KEY.replace(/(\d{4})/g, "$1 "))); // com espaços
    assert.ok(!isValidKey(KEY.slice(0, 43) + "9"));
    assert.ok(!isValidKey("123"));
    assert.deepEqual(keyParts(KEY), {
      uf: "22",
      anoMes: "08/2026",
      cnpjEmitente: "37354860000133",
      modelo: "55",
      serie: 226,
      numero: 3,
    });
    assert.equal(formatKey(KEY), "2226 0837 3548 6000 0133 5522 6000 0000 0318 2024 4645");
  });

  it("entende o que foi digitado na busca", () => {
    assert.deepEqual(parseNoteQuery(` ${KEY} `), { kind: "chave", value: KEY });
    assert.deepEqual(parseNoteQuery("12.345"), { kind: "numero", value: 12345 });
    assert.deepEqual(parseNoteQuery("98.765.432/0001-10"), { kind: "documento", value: "98765432000110" });
    assert.deepEqual(parseNoteQuery("030.772.474-37"), { kind: "documento", value: "03077247437" });
    assert.deepEqual(parseNoteQuery("Distribuidora, (Teresina)"), { kind: "nome", value: "Distribuidora Teresina" });
    assert.equal(parseNoteQuery("   "), null);
  });
});

describe("leitura do XML para a DANFE", () => {
  it("lê cabeçalho, partes, totais e itens", () => {
    const d = parseDanfe(XML);
    assert.ok(d);
    assert.equal(d.chave, KEY);
    assert.deepEqual([d.modelo, d.serie, d.numero, d.tipo, d.natureza], ["55", "226", "3", "1", "VENDA DE MERCADORIA"]);
    assert.equal(d.emitente.nome, "Ana & Cia"); // entidade decodificada
    assert.equal(d.emitente.endereco, "Av. Frei Serafim, 1234 · Centro");
    assert.equal(d.destinatario?.uf, "PB");
    assert.equal(d.protocolo, "222260019563855");
    assert.equal(d.totais.valorNota, "3877.50");
    assert.equal(d.itens.length, 2);
    assert.deepEqual([d.itens[0].cst, d.itens[0].aliqIcms, d.itens[1].cst], ["000", "18.00", "0102"]);
    assert.equal(d.transportadora, "TRANSPI LOG");
    assert.equal(d.infAdic, "Pedido 7781.");
    assert.equal(parseDanfe("<outro/>"), null);
  });

  it("formata valores, documentos e número", () => {
    assert.equal(formatMoney("3877.50"), "3.877,50");
    assert.equal(formatMoney(""), "0,00");
    assert.equal(formatDoc("37354860000133"), "37.354.860/0001-33");
    assert.equal(formatDoc("03077247437"), "030.772.474-37");
    assert.equal(formatNoteNumber(12345), "000.012.345");
  });
});
