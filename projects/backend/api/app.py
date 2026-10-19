import logging
import time
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from projects.backend.api.routes.console import router as console_router
from projects.backend.api.routes.infrastructure import router
from projects.backend.shared.configuration.settings import ROOT, Settings
from projects.backend.shared.model_inference.ollama import OllamaRuntime
from projects.backend.shared.observability.logging import configure_logging
from projects.backend.shared.storage.database import initialize

logger = logging.getLogger(__name__)
CONSOLE = ROOT / "projects" / "review-console"


def create_app(settings: Settings | None = None) -> FastAPI:
    configuration = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        configure_logging()
        initialize(configuration.database)
        configuration.evidence_dir.mkdir(parents=True, exist_ok=True)
        async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
            app.state.settings = configuration
            app.state.model = OllamaRuntime(
                client, configuration.ollama_url, configuration.ollama_model
            )
            logger.info("Local API started; production email and publication are disabled")
            yield
        logger.info("Local API stopped")

    app = FastAPI(title="Newsbee local API", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:4321", "http://localhost:4321"],
        allow_methods=["GET"],
    )
    app.mount("/review/static", StaticFiles(directory=CONSOLE / "static"), name="review-static")
    app.include_router(router)
    app.include_router(console_router)

    @app.middleware("http")
    async def request_logging(request: Request, call_next):
        start = time.monotonic()
        try:
            response = await call_next(request)
        except Exception:
            logger.exception("Request failed: %s %s", request.method, request.url.path)
            raise
        logger.info(
            "%s %s status=%s duration_ms=%.1f",
            request.method,
            request.url.path,
            response.status_code,
            (time.monotonic() - start) * 1000,
        )
        return response

    return app


app = create_app()
