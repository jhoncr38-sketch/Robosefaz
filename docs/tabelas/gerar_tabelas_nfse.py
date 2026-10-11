"""Gera apps/web/src/lib/nfse-tabelas-data.ts a partir das tabelas oficiais da NFS-e nacional (gov.br/nfse).

As listas da tela "Emitir NFS-e" (código de tributação nacional, NBS, indicador da operação e classificação
tributária) saem daqui. Quando o portal publicar versão nova, baixe os arquivos e rode de novo:

  python gerar_tabelas_nfse.py <AnexoVIII.xlsx> <AnexoVII.xlsx> <lista-nacional.html>

  Anexo VIII (correlação item x NBS x indicador x cClassTrib) e Anexo VII (indicadores de operação):
    https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc
  Lista nacional (salvar a página como HTML):
    https://www.gov.br/nfse/pt-br/mei-e-demais-empresas/codigos-de-tributacao-nacional-nbs

Só usa a biblioteca padrão. As planilhas têm células mescladas: cada célula vale o valor do canto da mescla.
"""
import datetime
import html
import json
import pathlib
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

M = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS = {"m": M}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
OUT = pathlib.Path(__file__).resolve().parents[2] / "apps" / "web" / "src" / "lib" / "nfse-tabelas-data.ts"

# Situação tributária (CST) do IBS/CBS: os três primeiros números do cClassTrib.
# Tabela do Portal da Conformidade Fácil (dfe-portal.svrs.rs.gov.br/DFE/ClassificacaoTributaria), lida em 11/10/2026.
CST = {
    "000": "Tributação integral",
    "010": "Tributação com alíquotas uniformes",
    "011": "Tributação com alíquotas uniformes reduzidas",
    "200": "Alíquota reduzida",
    "220": "Alíquota fixa",
    "221": "Alíquota fixa proporcional",
    "222": "Redução de Base de Cálculo",
    "400": "Isenção",
    "410": "Imunidade e não incidência",
    "510": "Diferimento",
    "515": "Diferimento com redução de alíquota",
    "550": "Suspensão",
    "620": "Tributação Monofásica",
    "800": "Transferência de crédito",
    "810": "Ajuste de IBS na ZFM",
    "811": "Ajustes",
    "820": "Tributação em documento específico",
    "830": "Exclusão da Base de Cálculo",
}


def col_index(ref):
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def clean(text):
    return re.sub(r"\s+", " ", text or "").strip()


def sheet_grid(path, sheet, width):
    """Linhas da aba com as mesclas desfeitas (cada célula mesclada repete o valor do canto)."""
    with zipfile.ZipFile(path) as zf:
        shared = []
        if "xl/sharedStrings.xml" in zf.namelist():
            for si in ET.fromstring(zf.read("xl/sharedStrings.xml")).findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter("{%s}t" % M)))
        wb = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))}
        target = next(rels[s.get(REL)] for s in wb.find("m:sheets", NS) if s.get("name") == sheet).lstrip("/")
        root = ET.fromstring(zf.read(target if target.startswith("xl/") else "xl/" + target))
    rows = {}
    for row in root.iter("{%s}row" % M):
        cells = [""] * width
        for c in row.findall("m:c", NS):
            i = col_index(c.get("r"))
            v = c.find("m:v", NS)
            if i >= width:
                continue
            if c.get("t") == "s" and v is not None:
                cells[i] = shared[int(v.text)]
            elif c.get("t") == "inlineStr":
                cells[i] = "".join(t.text or "" for t in c.iter("{%s}t" % M))
            elif v is not None:
                cells[i] = v.text or ""
        rows[int(row.get("r"))] = [clean(x) for x in cells]
    for m in root.iter("{%s}mergeCell" % M):
        a, b = m.get("ref").split(":")
        c1, r1, c2, r2 = col_index(a), int(re.search(r"\d+", a).group(0)), col_index(b), int(re.search(r"\d+", b).group(0))
        for r in range(r1, r2 + 1):
            for c in range(c1, min(c2, width - 1) + 1):
                if c1 < width and r in rows and r1 in rows:
                    rows[r][c] = rows[r1][c1]
    return [rows[r] for r in sorted(rows)]


def digits(text):
    return re.sub(r"\D", "", text)


def correlation(path):
    """item (4 ou 6 números) -> [[NBS, [indicadores], [cClassTrib]]], mais os nomes de NBS e de cClassTrib."""
    rows = sheet_grid(path, "tabela geral", 10)
    head = [x.lower() for x in rows[0]]
    assert head[0].startswith("item") and head[2] == "nbs" and head[6] == "indop" and head[8] == "cclasstrib", f"cabeçalho inesperado: {rows[0]}"
    items, nbs_names, class_names = {}, {}, {}
    for r in rows[1:]:
        item, nbs, ind, cct = digits(r[0]), digits(r[2]), digits(r[6]), digits(r[8])
        if len(item) not in (4, 6):
            continue
        if nbs and len(nbs) != 9:
            raise SystemExit(f"NBS fora do formato: {r}")
        if (ind and len(ind) != 6) or (cct and len(cct) != 6):
            raise SystemExit(f"indicador ou cClassTrib fora do formato: {r}")
        entry = items.setdefault(item, {}).setdefault(nbs, ([], []))
        if ind and ind not in entry[0]:
            entry[0].append(ind)
        if cct and cct not in entry[1]:
            entry[1].append(cct)
        if nbs and r[3]:
            nbs_names.setdefault(nbs, r[3])
        if cct and r[9]:
            class_names.setdefault(cct, r[9])
    table = {item: [[nbs, sorted(v[0]), sorted(v[1])] for nbs, v in by_nbs.items()] for item, by_nbs in sorted(items.items())}
    return table, nbs_names, class_names


def operation_indicators(path):
    """Indicadores de operação que valem para a NFS-e: código -> [tipo de operação, característica, local de incidência do IBS]."""
    rows = sheet_grid(path, "cIndOp Public", 10)
    head = [x.lower() for x in rows[0]]
    assert "indop" in head[0] and head[7] == "indnfse", f"cabeçalho inesperado: {rows[0]}"
    out = {}
    for r in rows[1:]:
        code = digits(r[0])
        if len(code) != 6 or r[7].upper() != "S":
            continue
        out[code] = [r[1].rstrip("."), r[2].rstrip("."), "" if r[9] in ("", "-") else r[9]]
    return out


def national_list(path):
    """Lista nacional (LC 116 desdobrada em 6 números) da página do portal."""
    page = pathlib.Path(path).read_text(encoding="utf-8", errors="replace")
    out = {}
    for cell in re.findall(r"<td[^>]*>(.*?)</td>", page, re.S | re.I):
        m = re.match(r"^(\d{6})\s*[-–]\s*(.+)$", clean(html.unescape(re.sub(r"<[^>]+>", " ", cell))))
        if m:
            out.setdefault(m.group(1), m.group(2))
    return dict(sorted(out.items()))


def version(path):
    """"...v1-01-00.xlsx" -> "v1.01.00"."""
    m = re.search(r"v(\d+)[-.](\d+)[-.](\d+)", pathlib.Path(path).name, re.I)
    return "v" + ".".join(m.groups()) if m else "versão não identificada"


def main(anexo8, anexo7, lista):
    table, nbs_names, class_names = correlation(anexo8)
    ind = operation_indicators(anexo7)
    nacional = national_list(lista)
    used_ind = {i for rows in table.values() for _, inds, _ in rows for i in inds}
    missing = sorted(used_ind - set(ind))
    sem_item = sorted(c for c in nacional if c not in table and c[:4] not in table)
    today = datetime.date.today().strftime("%d/%m/%Y")
    js = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    lines = [
        "// Tabelas oficiais da NFS-e nacional para as listas da tela Emitir NFS-e. GERADO: não editar à mão.",
        f"// Fonte: gov.br/nfse — Anexo VIII ({version(anexo8)}), Anexo VII ({version(anexo7)}) e lista nacional de serviços, lidos em {today}.",
        "// Para atualizar: docs/tabelas/gerar_tabelas_nfse.py. Carregado só quando alguém abre um rascunho de nota.",
        "",
        "/** Código de tributação nacional (6 números) -> descrição. */",
        f"export const TRIB_NACIONAL: Record<string, string> = {js(nacional)};",
        "",
        "/** Item da LC 116 (4 números; em poucos casos, os 6) -> [NBS, indicadores da operação, classificações tributárias]. */",
        f"export const CORRELACAO: Record<string, [string, string[], string[]][]> = {js(table)};",
        "",
        "/** NBS (9 números) -> descrição. */",
        f"export const NBS_NOMES: Record<string, string> = {js(dict(sorted(nbs_names.items())))};",
        "",
        "/** Indicador da operação (cIndOp) aceito na NFS-e -> [tipo de operação, característica, local de incidência do IBS]. */",
        f"export const IND_OP: Record<string, [string, string, string]> = {js(dict(sorted(ind.items())))};",
        "",
        "/** Classificação tributária (cClassTrib) -> descrição. */",
        f"export const CLASS_TRIB: Record<string, string> = {js(dict(sorted(class_names.items())))};",
        "",
        "/** Situação tributária do IBS/CBS (CST): os três primeiros números do cClassTrib. */",
        f"export const CST: Record<string, string> = {js(CST)};",
        "",
    ]
    OUT.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"gravado {OUT} ({OUT.stat().st_size} bytes)")
    print(f"lista nacional: {len(nacional)} | itens na correlação: {len(table)} (com 6 números: {sorted(k for k in table if len(k) == 6)})")
    print(f"NBS: {len(nbs_names)} | indicadores para NFS-e: {len(ind)} | cClassTrib: {len(class_names)} | CST usados: {sorted({c[:3] for c in class_names})}")
    print(f"indicadores da correlação sem descrição no Anexo VII: {missing}")
    print(f"códigos nacionais sem linha na correlação: {len(sem_item)} {sem_item[:12]}")
    print(f"itens sem NBS: {sorted(k for k, rows in table.items() if all(not n for n, _, _ in rows))}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
