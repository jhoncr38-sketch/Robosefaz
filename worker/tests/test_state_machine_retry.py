"""Máquina de estados e política de retry."""

from datetime import datetime, timedelta, timezone

import pytest

from app.jobs.errors import AutomationError, ErrorCode, NON_RETRYABLE_CODES, is_retryable
from app.jobs.retry import RetryPolicy
from app.jobs.state_machine import (
    InvalidTransitionError,
    JobStateMachine,
    JobStatus,
    can_transition,
    label_for,
    progress_for,
)


class TestStateMachine:
    def test_happy_path_scheduler(self) -> None:
        sm = JobStateMachine(JobStatus.QUEUED)
        for s in [
            JobStatus.STARTING,
            JobStatus.OPENING_BROWSER,
            JobStatus.OPENING_SIAT,
            JobStatus.WAITING_CERTIFICATE,
            JobStatus.AUTHENTICATING,
            JobStatus.SELECTING_TAXPAYER,
            JobStatus.OPENING_SIAT_MODULE,
            JobStatus.NAVIGATING_EXPORT,
            JobStatus.SCHEDULING_NFCE,
            JobStatus.SCHEDULING_NFE_ISSUED,
            JobStatus.SCHEDULING_NFE_RECEIVED,
            JobStatus.WAITING_SEFAZ,
        ]:
            sm.transition(s)
        assert sm.state == JobStatus.WAITING_SEFAZ
        assert sm.progress == 80

    def test_happy_path_collector(self) -> None:
        sm = JobStateMachine(JobStatus.WAITING_SEFAZ, phase="collect")
        sm.transition(JobStatus.CHECKING_PROCESSING)
        sm.transition(JobStatus.OPENING_BROWSER)
        assert sm.progress == 85  # não regride no collector
        for s in [JobStatus.CHECKING_PROCESSING, JobStatus.DOWNLOAD_AVAILABLE, JobStatus.DOWNLOADING,
                  JobStatus.ORGANIZING_FILES, JobStatus.COMPLETED]:
            sm.transition(s)
        assert sm.is_terminal and sm.progress == 100

    @pytest.mark.parametrize(
        ("current", "target"),
        [
            (JobStatus.QUEUED, JobStatus.DOWNLOADING),
            (JobStatus.QUEUED, JobStatus.SCHEDULING_NFCE),
            (JobStatus.COMPLETED, JobStatus.SCHEDULING_NFCE),
            (JobStatus.FAILED, JobStatus.DOWNLOADING),
            (JobStatus.CANCELLED, JobStatus.STARTING),
            (JobStatus.WAITING_SEFAZ, JobStatus.SCHEDULING_NFCE),
            (JobStatus.STARTING, JobStatus.DOWNLOADING),
        ],
    )
    def test_invalid_transitions(self, current: JobStatus, target: JobStatus) -> None:
        assert not can_transition(current, target)
        with pytest.raises(InvalidTransitionError):
            JobStateMachine(current).transition(target)

    def test_manual_action_roundtrip(self) -> None:
        sm = JobStateMachine(JobStatus.OPENING_SIAT)
        sm.transition(JobStatus.MANUAL_ACTION_REQUIRED)
        sm.transition(JobStatus.OPENING_SIAT)
        assert sm.history[-3:] == [JobStatus.OPENING_SIAT, JobStatus.MANUAL_ACTION_REQUIRED, JobStatus.OPENING_SIAT]

    def test_terminal_only_back_to_queue(self) -> None:
        for t in (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED):
            assert can_transition(t, JobStatus.QUEUED)

    def test_labels_and_progress(self) -> None:
        assert label_for("scheduling_nfce") == "Agendando NFC-e"
        assert progress_for(JobStatus.OPENING_SIAT) == 35
        assert progress_for(JobStatus.SCHEDULING_NFCE) == 50
        assert progress_for(JobStatus.SCHEDULING_NFE_RECEIVED) == 70
        assert progress_for(JobStatus.DOWNLOADING) == 95


class TestRetry:
    def test_backoff_10_30_60(self) -> None:
        policy = RetryPolicy()
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)
        err = AutomationError(ErrorCode.TIMEOUT, "timeout")
        d1 = policy.decide(err, 1, now=base)
        d2 = policy.decide(err, 2, now=base)
        d3 = policy.decide(err, 3, now=base)
        assert (d1.retry, d1.delay_seconds, d1.next_attempt_at) == (True, 10, base + timedelta(seconds=10))
        assert (d2.retry, d2.delay_seconds) == (True, 30)
        assert (d3.retry, d3.delay_seconds) == (True, 60)
        assert not policy.decide(err, 4, now=base).retry

    @pytest.mark.parametrize(
        "code",
        [
            ErrorCode.TAXPAYER_MISMATCH,
            ErrorCode.CERTIFICATE_EXPIRED,
            ErrorCode.INVALID_CONFIGURATION,
            ErrorCode.MANUAL_ACTION_REQUIRED,
            ErrorCode.SECURITY_CLIENT_MISMATCH,
        ],
    )
    def test_non_retryable(self, code: ErrorCode) -> None:
        err = AutomationError(code, "x")
        assert code in NON_RETRYABLE_CODES
        assert not is_retryable(err)
        assert not RetryPolicy().decide(err, 1).retry

    def test_forced_retryable_flag_cannot_override_blocklist(self) -> None:
        err = AutomationError(ErrorCode.TAXPAYER_MISMATCH, "x", retryable=True)
        assert not err.retryable

    def test_unexpected_errors_retry(self) -> None:
        assert RetryPolicy().decide(RuntimeError("boom"), 1).retry

    def test_delay_for_bounds(self) -> None:
        policy = RetryPolicy()
        assert policy.delay_for(99) == 60
        with pytest.raises(ValueError):
            policy.delay_for(0)
