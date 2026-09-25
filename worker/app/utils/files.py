"""Utilitários de arquivo: hash, nomes seguros e escrita atômica."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
from pathlib import Path

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sniff_kind(path: Path) -> str:
    """Identifica o conteúdo pelos primeiros bytes: zip | xml | html | unknown."""
    with path.open("rb") as fh:
        head = fh.read(512)
    if head.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
        return "zip"
    text = head.lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if text.startswith(b"<?xml"):
        return "xml"
    if text.startswith((b"<!doctype html", b"<html")) or b"<html" in text[:200]:
        return "html"
    return "unknown"


def safe_name(value: str) -> str:
    cleaned = _UNSAFE.sub("_", value).strip("._")
    return cleaned or "arquivo"


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_within(base: Path, target: Path) -> Path:
    """Garante que target está dentro de base (evita path traversal)."""
    base_r = base.resolve()
    target_r = target.resolve()
    if base_r != target_r and base_r not in target_r.parents:
        raise ValueError(f"Caminho fora do diretório permitido: {target}")
    return target_r


def move_atomic(src: Path, dst: Path) -> Path:
    ensure_dir(dst.parent)
    tmp = dst.with_suffix(dst.suffix + ".part")
    shutil.copy2(src, tmp)
    os.replace(tmp, dst)
    try:
        src.unlink()
    except OSError:
        pass
    return dst
