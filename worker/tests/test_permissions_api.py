"""Permissões por papel na API (admin / operator / viewer)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.api import deps
from app.api.deps import ROLE_LEVEL, CurrentUser
from app.main import create_app


def _user(role: str) -> CurrentUser:
    return CurrentUser(id="u1", email="u@x.com", name="U", role=role, token="tok")


@pytest.fixture
def make_client(monkeypatch: pytest.MonkeyPatch):
    calls: list[tuple[str, dict]] = []

    async def fake_rpc(settings, user, fn, params):  # noqa: ANN001, ANN202
        calls.append((fn, params))
        if fn == "create_automation_jobs_batch":
            return [{"job_id": "j1", "client_id": cid} for cid in params["p_client_ids"]]
        return {"ok": True, "fn": fn}

    monkeypatch.setattr("app.api.routes_jobs.user_rpc", fake_rpc)

    def _factory(role: str | None) -> tuple[TestClient, list]:
        app = create_app()
        if role is not None:
            app.dependency_overrides[deps.current_user] = lambda: _user(role)
        return TestClient(app), calls

    return _factory


def test_role_hierarchy() -> None:
    assert _user("admin").has_role("operator")
    assert _user("operator").has_role("viewer")
    assert not _user("viewer").has_role("operator")
    assert not _user("operator").has_role("admin")
    assert ROLE_LEVEL == {"viewer": 1, "operator": 2, "admin": 3}


def test_requires_token(make_client) -> None:  # noqa: ANN001
    client, _ = make_client(None)
    r = client.post("/jobs/abc/cancel")
    assert r.status_code == 401


@pytest.mark.parametrize(
    ("role", "path", "expected"),
    [
        ("viewer", "/jobs/abc/cancel", 403),
        ("operator", "/jobs/abc/cancel", 200),
        ("operator", "/jobs/abc/retry", 403),
        ("admin", "/jobs/abc/retry", 200),
        ("viewer", "/jobs/abc/confirm", 403),
        ("operator", "/jobs/abc/confirm", 200),
    ],
)
def test_job_actions_by_role(make_client, role: str, path: str, expected: int) -> None:  # noqa: ANN001
    client, _ = make_client(role)
    assert client.post(path).status_code == expected


def test_create_jobs_permissions(make_client) -> None:  # noqa: ANN001
    body = {"client_ids": ["c1", "c2"], "competence": "08/2026"}
    viewer, _ = make_client("viewer")
    assert viewer.post("/jobs", json=body).status_code == 403

    operator, calls = make_client("operator")
    r = operator.post("/jobs", json=body)
    assert r.status_code == 201
    fn, params = calls[-1]
    assert fn == "create_automation_jobs_batch"
    assert params["p_competence"] == "2026-08"
    assert params["p_operations"] == ["NFCE_EXPORT", "NFE_ISSUED_EXPORT", "NFE_RECEIVED_EXPORT"]

    # somente admin pode forçar novo agendamento
    assert operator.post("/jobs", json={**body, "force": True}).status_code == 403
    admin, _ = make_client("admin")
    assert admin.post("/jobs", json={**body, "force": True}).status_code == 201


def test_client_automation_validation(make_client) -> None:  # noqa: ANN001
    operator, _ = make_client("operator")
    assert operator.post("/clients/c1/automation", json={"competence": "13/2026"}).status_code == 422
    assert operator.post(
        "/clients/c1/automation", json={"competence": "2026-08", "operations": ["DOWNLOAD"]}
    ).status_code == 422
    assert operator.post(
        "/clients/c1/automation", json={"competence": "2026-08", "operations": ["NFCE_EXPORT"]}
    ).status_code == 201


def test_certificate_endpoints_admin_only(make_client) -> None:  # noqa: ANN001
    operator, _ = make_client("operator")
    assert operator.get("/certificates/store").status_code == 403
    assert operator.post("/certificates/inspect", files={"file": ("a.pfx", b"x")}).status_code == 403
