"""API FastAPI: `uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api import routes_certificates, routes_clients, routes_health, routes_jobs
from app.config import get_settings
from app.logs.job_logger import configure_logging
from app.utils.files import ensure_dir


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level)
    for d in (settings.downloads_dir, settings.profiles_dir, settings.errors_dir, settings.screenshots_dir):
        try:
            ensure_dir(d)
        except OSError as exc:  # ex.: unidade de rede desconectada
            logging.getLogger("api").warning("Pasta indisponível %s: %s", d, exc)
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="SIAT Automation API",
        version=__version__,
        description="API do robô de automação do SIAT Web (SEFAZ-PI).",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.include_router(routes_health.router)
    app.include_router(routes_jobs.router)
    app.include_router(routes_clients.router)
    app.include_router(routes_certificates.router)
    return app


app = create_app()
