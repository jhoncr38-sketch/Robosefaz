"""Índice das notas dentro dos ZIPs e o XML sob demanda (só leitura)."""

from __future__ import annotations

import zipfile
from pathlib import Path

from app.downloads.note_index import (
    index_pending_notes,
    index_zip,
    note_rows,
    parse_note_xml,
    read_note_xml,
    serve_note_xml_requests,
)
from fakes import FakeRepo

KEY = "22260837354860000133552260000000031820244645"
OTHER = "22260837354860000133552260000000021198885940"

NFE = """<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="NFe{key}" versao="4.00">
      <ide><cUF>22</cUF><mod>55</mod><serie>226</serie><nNF>3</nNF><dhEmi>2026-08-03T08:08:48-03:00</dhEmi></ide>
      <emit><CNPJ>37354860000133</CNPJ><xNome>Ana Maria de Moura Fernandes</xNome>
        <enderEmit><xMun>Teresina</xMun><UF>PI</UF></enderEmit><IE>196677149</IE></emit>
      <dest><CPF>03077247437</CPF><xNome>Henrique Diniz</xNome><enderDest><UF>PB</UF></enderDest></dest>
      <total><ICMSTot><vProd>21.14</vProd><vNF>21.14</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
  <protNFe versao="4.00"><infProt><nProt>222260019563855</nProt><cStat>100</cStat></infProt></protNFe>
</nfeProc>"""


def _zip(path: Path, members: dict[str, str]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        for name, content in members.items():
            zf.writestr(name, content)
    return path


def test_parse_reads_the_main_fields() -> None:
    n = parse_note_xml(NFE.format(key=KEY).encode(), f"{KEY}.xml")
    assert n is not None
    assert (n.chave, n.modelo, n.serie, n.numero) == (KEY, 55, 226, 3)
    assert n.emitida_em == "2026-08-03T08:08:48-03:00" and n.valor == "21.14"
    assert (n.emit_doc, n.emit_nome, n.emit_uf) == ("37354860000133", "Ana Maria de Moura Fernandes", "PI")
    assert (n.dest_doc, n.dest_nome, n.dest_uf) == ("03077247437", "Henrique Diniz", "PB")
    assert n.cstat == "100" and n.xml_name == f"{KEY}.xml"


def test_parse_ignores_what_is_not_a_note() -> None:
    assert parse_note_xml(b"nao e xml", "a.xml") is None
    assert parse_note_xml(b"<outro><coisa/></outro>", "a.xml") is None
    # chave pelo nome do arquivo quando o Id vem estranho
    n = parse_note_xml(NFE.format(key="X").encode(), f"TP-1/PI/{KEY}.xml")
    assert n is not None and n.chave == KEY


def test_index_zip_and_rows(tmp_path: Path) -> None:
    z = _zip(tmp_path / "a.zip", {f"{KEY}.xml": NFE.format(key=KEY), f"{OTHER}.xml": NFE.format(key=OTHER), "leia-me.txt": "x"})
    before = z.read_bytes()
    notes = index_zip(z)
    assert notes is not None and [n.chave for n in notes] == [KEY, OTHER]
    assert z.read_bytes() == before  # só lê
    assert index_zip(tmp_path / "nao-existe.zip") is None
    rows = note_rows({"id": "d1", "client_id": "c1", "document_type": "NFE_EMITIDAS_CANCELADAS", "competence": "2026-08"}, z, notes)
    assert rows[0]["canceled"] is True and rows[0]["zip_path"] == str(z) and rows[0]["download_id"] == "d1"
    assert rows[0]["chave"] == KEY and rows[0]["numero"] == 3


async def test_index_pending_and_serve_xml(tmp_path: Path) -> None:
    repo = FakeRepo()
    base = tmp_path / "notas"
    z = _zip(base / "2026" / "08" / "LOJA" / "NFE_EMITIDAS" / "LOJA - NF-e emitidas - 08-2026 - CLI000003.zip", {f"{KEY}.xml": NFE.format(key=KEY)})
    repo.downloads.append({"id": "d1", "client_id": "c1", "document_type": "NFE_EMITIDAS", "competence": "2026-08", "filepath": str(z), "size": z.stat().st_size, "checksum": "x"})
    repo.downloads.append({"id": "d2", "client_id": "c1", "document_type": "NFCE", "competence": "2026-08", "filepath": str(tmp_path / "sumiu.zip"), "size": 1, "checksum": "y"})
    skip: set[str] = set()
    assert await index_pending_notes(repo, base, skip=skip) == 1
    assert skip == {"d2"}  # ZIP que não está aqui fica para depois, sem travar os outros
    assert repo.downloads[0]["notes_indexed_at"] and repo.downloads[0]["note_count"] == 1
    assert [n["chave"] for n in repo.notes] == [KEY]
    # indexar de novo não duplica
    repo.downloads[0]["notes_indexed_at"] = None
    await index_pending_notes(repo, base, skip=skip)
    assert len(repo.notes) == 1

    # painel pede o XML
    note = repo.notes[0]
    note["xml_requested_at"] = "2026-10-06T10:00:00+00:00"
    served: set[tuple[str, str]] = set()
    assert await serve_note_xml_requests(repo, base, skip=served) == 1
    assert note["xml"].startswith("<?xml") and KEY in note["xml"] and note["xml_error"] is None
    # ZIP de outro computador: deixa pendente e não insiste
    repo.notes.append({"id": "n2", "client_id": "c1", "document_type": "NFCE", "chave": OTHER, "xml_name": "x.xml", "zip_path": r"Z:\outra\pasta.zip", "download_id": None, "xml": None, "xml_error": None, "xml_requested_at": "2026-10-06T10:00:01+00:00"})
    assert await serve_note_xml_requests(repo, base, skip=served) == 0
    assert ("n2", "2026-10-06T10:00:01+00:00") in served


def test_read_note_xml_by_key_when_name_changed(tmp_path: Path) -> None:
    z = _zip(tmp_path / "a.zip", {f"pasta/{KEY}-nfe.xml": NFE.format(key=KEY)})
    xml = read_note_xml(z, f"{KEY}.xml", KEY)
    assert xml is not None and KEY in xml
    assert read_note_xml(z, "nada.xml", OTHER) is None
