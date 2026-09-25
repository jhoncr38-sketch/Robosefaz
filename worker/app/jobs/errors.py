"""Erros de automação com código e política de retry."""

from __future__ import annotations

from enum import StrEnum
from typing import Any


class ErrorCode(StrEnum):
    TAXPAYER_MISMATCH = "TAXPAYER_MISMATCH"
    SECURITY_CLIENT_MISMATCH = "SECURITY_CLIENT_MISMATCH"
    CERTIFICATE_EXPIRED = "CERTIFICATE_EXPIRED"
    CERTIFICATE_REQUIRED = "CERTIFICATE_REQUIRED"
    INVALID_CONFIGURATION = "INVALID_CONFIGURATION"
    MANUAL_ACTION_REQUIRED = "MANUAL_ACTION_REQUIRED"
    CANCELLED = "CANCELLED"
    EXPORT_ALREADY_SCHEDULED = "EXPORT_ALREADY_SCHEDULED"
    SIAT_UNAVAILABLE = "SIAT_UNAVAILABLE"
    LOGIN_FAILED = "LOGIN_FAILED"
    SELECTOR_NOT_FOUND = "SELECTOR_NOT_FOUND"
    TIMEOUT = "TIMEOUT"
    SCHEDULE_FAILED = "SCHEDULE_FAILED"
    EXPORT_NOT_FOUND = "EXPORT_NOT_FOUND"
    EXPORT_FAILED = "EXPORT_FAILED"
    DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
    PROFILE_IN_USE = "PROFILE_IN_USE"
    BROWSER_ERROR = "BROWSER_ERROR"
    COLLECTOR_EXHAUSTED = "COLLECTOR_EXHAUSTED"
    UNEXPECTED = "UNEXPECTED"


NON_RETRYABLE_CODES: frozenset[ErrorCode] = frozenset(
    {
        ErrorCode.TAXPAYER_MISMATCH,
        ErrorCode.SECURITY_CLIENT_MISMATCH,
        ErrorCode.CERTIFICATE_EXPIRED,
        ErrorCode.CERTIFICATE_REQUIRED,
        ErrorCode.INVALID_CONFIGURATION,
        ErrorCode.MANUAL_ACTION_REQUIRED,
        ErrorCode.CANCELLED,
        ErrorCode.EXPORT_ALREADY_SCHEDULED,
        ErrorCode.EXPORT_FAILED,
        ErrorCode.COLLECTOR_EXHAUSTED,
    }
)


class AutomationError(Exception):
    """Erro controlado da automação."""

    def __init__(
        self,
        code: ErrorCode | str,
        message: str,
        *,
        retryable: bool | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = ErrorCode(code)
        self.message = message
        self._retryable = retryable
        self.metadata = metadata or {}

    @property
    def retryable(self) -> bool:
        if self._retryable is not None:
            return self._retryable and self.code not in NON_RETRYABLE_CODES
        return self.code not in NON_RETRYABLE_CODES

    def __str__(self) -> str:
        return f"[{self.code}] {self.message}"


class TaxpayerMismatchError(AutomationError):
    def __init__(self, expected: str, found: str | None, *, security: bool = False) -> None:
        code = ErrorCode.SECURITY_CLIENT_MISMATCH if security else ErrorCode.TAXPAYER_MISMATCH
        super().__init__(
            code,
            f"Contribuinte aberto no portal ({found or 'não identificado'}) difere do cliente do job ({expected}).",
            metadata={"expected": expected, "found": found},
        )


class ManualActionRequired(AutomationError):
    def __init__(self, message: str) -> None:
        super().__init__(ErrorCode.MANUAL_ACTION_REQUIRED, message)


class JobCancelled(AutomationError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.CANCELLED, "Automação cancelada pelo usuário.")


def is_retryable(error: BaseException) -> bool:
    if isinstance(error, AutomationError):
        return error.retryable
    return True


def error_code_of(error: BaseException) -> ErrorCode:
    if isinstance(error, AutomationError):
        return error.code
    name = type(error).__name__.lower()
    if "timeout" in name:
        return ErrorCode.TIMEOUT
    return ErrorCode.UNEXPECTED
