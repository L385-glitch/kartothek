"""SQLite + SQLAlchemy setup.

Single-user, single-writer (the generation job). WAL mode gives us
concurrent reads from the API while the job writes, and makes the DB
robust against a crash mid-write.
"""
from __future__ import annotations

import logging
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings

log = logging.getLogger("studydeck.db")


class Base(DeclarativeBase):
    pass


def _migrate_legacy_db() -> None:
    """Rename the pre-rename database (kartothek.db) to studydeck.db.

    Runs once at startup so existing deployments keep their data after the
    project was renamed. Only renames when the new file does not already
    exist, and moves the WAL/SHM sidecar files along with it.
    """
    data = settings.data_dir
    legacy = data / "kartothek.db"
    current = data / "studydeck.db"
    if legacy.exists() and not current.exists():
        for suffix in ("", "-wal", "-shm"):
            src = data / f"kartothek.db{suffix}"
            if src.exists():
                try:
                    src.rename(data / f"studydeck.db{suffix}")
                except OSError:
                    # Leave it; the app will just start a fresh DB.
                    pass


def _make_engine(db_path: Path):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False, "timeout": 30},
        future=True,
    )

    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_conn, _record):  # pragma: no cover - tiny
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()

    return engine


_migrate_legacy_db()
engine = _make_engine(settings.db_path)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


def init_db() -> None:
    # Import models so they register on Base.metadata.
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _migrate_columns()


def _migrate_columns() -> None:
    """Add columns that create_all() can't add to pre-existing tables.

    SQLite's create_all only creates missing tables — it never ALTERs an
    existing one to add a column. We add new columns here, guarded by a
    pragma check so the migration is idempotent and cheap.
    """
    additions = {
        "documents": [("course_id", "VARCHAR(32) REFERENCES courses(id) ON DELETE SET NULL")],
    }
    with engine.begin() as conn:
        for table, cols in additions.items():
            rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
            existing = {r[1] for r in rows}
            if not existing:
                continue  # table doesn't exist yet (create_all made it)
            for name, decl in cols:
                if name not in existing:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                    log.info("migrated: added %s.%s", table, name)


@contextmanager
def get_session():
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_session_dep():
    """FastAPI dependency yielding a session."""
    with get_session() as session:
        yield session
