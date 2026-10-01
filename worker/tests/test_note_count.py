"""Quantidade de notas dentro dos ZIPs (manutenção, só leitura)."""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from app.downloads.note_count import count_notes, count_pending_notes, locate
from app.utils.files import sha256_file
from fakes import FakeRepo


def _zip(path: Path, names: list[str]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        for name in names:
            zf.writestr(name, "<nfeProc/>")
    return path


def test_counts_xmls_inside_the_zip(tmp_path: Path) -> None:
    keys = [f"TP-1/PI/2225103735486000013365002000000{i:04d}1257838449.xml" for i in range(3)]
    z = _zip(tmp_path / "a.zip", [*keys, "TP-1/PI/leia-me.txt"])
    before = z.read_bytes()
    assert count_notes(z) == 3
    assert z.read_bytes() == before  # só lê
    assert count_notes(_zip(tmp_path / "vazio.zip", [])) == 0  # ZIP vazio do SIAT
    broken = tmp_path / "quebrado.zip"
    broken.write_bytes(b"nao e zip")
    assert count_notes(broken) is None
    assert count_notes(tmp_path / "nao-existe.zip") is None


def test_locate_on_another_computer(tmp_path: Path) -> None:
    base = tmp_path / "JR Sistema - Notas"
    tail = ["2026", "08", "CLI000003 - LOJA", "NFCE", "LOJA - NFC-e - 08-2026 - CLI000003.zip"]
    z = _zip(base.joinpath(*tail), ["1.xml"])
    assert locate({"filepath": str(z)}, base) == z
    # baixado no PC com o Google Drive em H:, lido no PC com o Drive em G:
    other = r"H:\Meu Drive\JR Sistema - Notas\2026\08\CLI000003 - LOJA\NFCE\LOJA - NFC-e - 08-2026 - CLI000003.zip"
    assert locate({"filepath": other}, base) == z
    assert locate({"filepath": r"H:\outra\pasta.zip"}, base) is None
    assert locate({"filepath": ""}, base) is None


def test_locate_old_path_by_same_content(tmp_path: Path) -> None:
    """Caminho gravado antes de reorganizar a pasta (cliente/ano/mês, nome antigo): acha o arquivo
    do mesmo mês e tipo com o mesmo SHA-256; outro conteúdo com o mesmo tamanho não serve."""
    base = tmp_path / "JR Sistema - Notas"
    folder = base / "2026" / "08" / "LOJA SANTA ZELIA E SAO LUIS" / "NFCE"
    z = _zip(folder / "LOJA SANTA ZELIA E SAO LUIS - NFC-e - 08-2026 - CLI000003.zip", ["1.xml", "2.xml"])
    twin = _zip(folder / "LOJA SANTA ZELIA E SAO LUIS - NFC-e - 08-2026 - CLI000003 (2).zip", ["3.xml", "4.xml"])
    assert twin.stat().st_size == z.stat().st_size
    row = {
        "filepath": r"C:\SIAT-Robo\storage\downloads\CLI000003 - LOJA\2026\08\NFCE\CLI000003_2026-08_NFCE.zip",
        "competence": "2026-08",
        "document_type": "NFCE",
        "size": z.stat().st_size,
        "checksum": sha256_file(z),
    }
    assert locate(row, base) == z
    assert locate({**row, "document_type": "NFE_EMITIDAS"}, base) is None
    assert locate({**row, "checksum": "0" * 64}, base) is None


@pytest.mark.asyncio
async def test_count_pending_notes_counts_and_skips(tmp_path: Path) -> None:
    repo = FakeRepo()
    ok = _zip(tmp_path / "ok.zip", ["1.xml", "2.xml"])
    repo.downloads = [
        {"id": "d1", "filepath": str(ok)},
        {"id": "d2", "filepath": str(tmp_path / "subindo.zip")},  # ainda não chegou neste PC
        {"id": "d3", "filepath": str(ok), "note_count": 7},  # já contado
    ]
    skip: set[str] = set()
    assert await count_pending_notes(repo, tmp_path, skip=skip) == 1
    assert repo.downloads[0]["note_count"] == 2
    assert "note_count" not in repo.downloads[1] and skip == {"d2"}
    assert repo.downloads[2]["note_count"] == 7
    assert await count_pending_notes(repo, tmp_path, skip=skip) == 0  # d2 fica para o próximo início


@pytest.mark.asyncio
async def test_count_pending_notes_in_small_batches(tmp_path: Path) -> None:
    repo = FakeRepo()
    z = _zip(tmp_path / "n.zip", ["1.xml"])
    repo.downloads = [{"id": f"d{i}", "filepath": str(z)} for i in range(5)]
    assert await count_pending_notes(repo, tmp_path, skip=set(), limit=2) == 2
    assert sum(1 for d in repo.downloads if d.get("note_count") == 1) == 2


@pytest.mark.asyncio
async def test_worker_stops_counting_after_repeated_failures(settings, monkeypatch) -> None:  # noqa: ANN001
    import app.worker as w

    calls = 0

    async def boom(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        nonlocal calls
        calls += 1
        raise RuntimeError("column downloads.note_count does not exist")

    monkeypatch.setattr(w, "count_pending_notes", boom)
    worker = w.Worker(FakeRepo(), settings, worker_id="teste")  # type: ignore[arg-type]
    for _ in range(5):
        await worker._count_notes()  # nunca derruba a manutenção
    assert calls == 3
