"""Validação de CNPJ, competência e redação de logs."""

from datetime import date

import pytest

from app.logs.redaction import REDACTED, redact, redact_text
from app.utils.cnpj import extract_cnpjs, format_cnpj, normalize_cnpj, same_cnpj, validate_cnpj
from app.utils.competence import Competence, InvalidCompetenceError, competence_bounds


class TestCnpj:
    @pytest.mark.parametrize("value", ["11.222.333/0001-81", "11222333000181", " 11222333000181 "])
    def test_valid_numeric(self, value: str) -> None:
        assert validate_cnpj(value)

    @pytest.mark.parametrize(
        "value",
        ["11.222.333/0001-82", "00000000000000", "11111111111111", "123", "", None, "1122233300018A"],
    )
    def test_invalid(self, value) -> None:  # noqa: ANN001
        assert not validate_cnpj(value)

    def test_valid_alphanumeric(self) -> None:
        # exemplo oficial da Receita Federal para o CNPJ alfanumérico
        assert validate_cnpj("12.ABC.345/01DE-35")
        assert not validate_cnpj("12.ABC.345/01DE-36")

    def test_normalize_and_format(self) -> None:
        assert normalize_cnpj("11.222.333/0001-81") == "11222333000181"
        assert format_cnpj("11222333000181") == "11.222.333/0001-81"
        assert format_cnpj("12abc34501de35") == "12.ABC.345/01DE-35"

    def test_extract_and_compare(self) -> None:
        text = "EMPRESA A LTDA:11222333000181 - AC XPTO | outro 11.444.777/0001-61"
        assert extract_cnpjs(text) == ["11222333000181", "11444777000161"]
        assert same_cnpj("11.222.333/0001-81", "11222333000181")
        assert not same_cnpj("", "")


class TestCompetence:
    def test_parse_both_formats(self) -> None:
        assert Competence.parse("2026-08").key == "2026-08"
        assert Competence.parse("08/2026").key == "2026-08"
        assert Competence.parse("2026-08").display == "08/2026"

    def test_bounds(self) -> None:
        assert competence_bounds("08/2026") == (date(2026, 8, 1), date(2026, 8, 31))
        assert competence_bounds("2024-02") == (date(2024, 2, 1), date(2024, 2, 29))
        assert competence_bounds("2026-02") == (date(2026, 2, 1), date(2026, 2, 28))
        assert competence_bounds("2026-12") == (date(2026, 12, 1), date(2026, 12, 31))

    @pytest.mark.parametrize("value", ["2026-13", "13/2026", "2026/08", "08-2026", "", "2026-8"])
    def test_invalid(self, value: str) -> None:
        with pytest.raises(InvalidCompetenceError):
            Competence.parse(value)


class TestRedaction:
    def test_redacts_sensitive_keys(self) -> None:
        data = {"senha": "123", "password": "x", "pin": "0000", "nested": {"api_key": "k", "token": "t"}, "cnpj": "1"}
        out = redact(data)
        assert out["senha"] == REDACTED
        assert out["password"] == REDACTED
        assert out["pin"] == REDACTED
        assert out["nested"]["api_key"] == REDACTED
        assert out["nested"]["token"] == REDACTED
        assert out["cnpj"] == "1"

    def test_keeps_safe_keys(self) -> None:
        out = redact({"dedup_key": "a|b", "mapping": "ok", "has_secret": True})
        assert out == {"dedup_key": "a|b", "mapping": "ok", "has_secret": True}

    def test_redacts_text(self) -> None:
        assert "1234" not in redact_text("senha=1234 ok")
        assert "abc" not in redact_text("Authorization: Bearer abc.def-ghi")
        pem = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----"
        assert "MIIE" not in redact_text(f"chave {pem}")
