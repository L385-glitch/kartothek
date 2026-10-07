"""FastAPI application entrypoint.

Serves the JSON API under /api and the built frontend (static assets)
at /, so a single container exposes everything on one port.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .api import cards, courses, decks, exams, io, jobs, materials, review
from .config import settings
from .database import init_db
from .pipeline import exam_jobs as exam_runner
from .pipeline import jobs as job_runner

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("studydeck")

# Where the built frontend lives (copied in by the Docker build).
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.ensure_dirs()
    init_db()
    # Crash recovery: resume any jobs that were running when we last died.
    job_runner.resume_pending()
    exam_runner.resume_pending()
    log.info("studydeck started (data=%s, llm=%s/%s)",
             settings.data_dir, settings.llm_base_url, settings.llm_model)
    yield


app = FastAPI(title="Studydeck", version="1.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(courses.router, prefix="/api")
app.include_router(decks.router, prefix="/api")
app.include_router(jobs.router, prefix="/api")
app.include_router(materials.router, prefix="/api")
app.include_router(exams.router, prefix="/api")
app.include_router(cards.router, prefix="/api")
app.include_router(review.router, prefix="/api")
app.include_router(io.router, prefix="/api")

# Serve generated figure crops at /figures/<deck>/<file>.
settings.ensure_dirs()
app.mount("/figures", StaticFiles(directory=str(settings.figures_dir)),
          name="figures")


@app.get("/api/health")
def health():
    return {"ok": True, "service": "studydeck", "version": app.version}


# Serve the frontend last so /api wins.
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")


def main() -> None:
    import uvicorn
    uvicorn.run("app.main:app", host=settings.host, port=settings.port,
                log_level="info")


if __name__ == "__main__":
    main()
