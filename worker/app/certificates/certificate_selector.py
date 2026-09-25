"""Escolha do certificado na lista exibida pelo portal (Web PKI).

O SIAT lista os certificados em uma tabela da própria página no formato
"subjectName - issuerName - email". A escolha só é automática quando existe
exatamente UMA linha compatível com o certificado configurado; caso
contrário o robô pede intervenção manual (nunca "chuta").
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from app.jobs.models import Certificate
from app.utils.cnpj import extract_cnpjs, normalize_cnpj


def _norm(text: str | None) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", text).strip().upper()


@dataclass(frozen=True, slots=True)
class SelectionResult:
    index: int | None
    reason: str
    candidates: int

    @property
    def found(self) -> bool:
        return self.index is not None


class CertificateSelector:
    def __init__(self, certificate: Certificate, client_cnpj: str | None = None) -> None:
        self.certificate = certificate
        self.client_cnpj = normalize_cnpj(client_cnpj)

    def _subject_matches(self, row: str) -> bool:
        subject = _norm(self.certificate.subject_name)
        return bool(subject) and subject in _norm(row)

    def _issuer_matches(self, row: str) -> bool:
        issuer = _norm(self.certificate.issuer)
        if not issuer:
            return True
        # issuer pode estar gravado como DN completo; basta o CN aparecer
        cn = re.search(r"CN=([^,]+)", issuer)
        needle = cn.group(1).strip() if cn else issuer
        return needle in _norm(row)

    def choose(self, rows: list[str]) -> SelectionResult:
        if not rows:
            return SelectionResult(None, "Nenhum certificado listado pelo portal.", 0)

        by_subject = [i for i, r in enumerate(rows) if self._subject_matches(r) and self._issuer_matches(r)]
        if len(by_subject) == 1:
            return SelectionResult(by_subject[0], "Titular e emissor conferem.", 1)
        if len(by_subject) > 1:
            return SelectionResult(None, "Mais de um certificado com o mesmo titular; seleção manual necessária.", len(by_subject))

        if self.client_cnpj:
            by_cnpj = [i for i, r in enumerate(rows) if self.client_cnpj in extract_cnpjs(r.replace(":", " "))]
            if len(by_cnpj) == 1:
                return SelectionResult(by_cnpj[0], "CNPJ do cliente encontrado no titular.", 1)
            if len(by_cnpj) > 1:
                return SelectionResult(None, "Mais de um certificado com o CNPJ do cliente; seleção manual necessária.", len(by_cnpj))

        return SelectionResult(None, "Certificado configurado não aparece na lista do portal.", 0)
