# Kartothek — single-container image
# Stage 1: build the React frontend (Vite)
FROM node:20-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-fund --no-audit
COPY frontend/ ./
RUN npm run build

# Stage 2: Python runtime + backend + built frontend
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    KARTOTHEK_DATA=/data \
    PORT=8000

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY --from=frontend /build/dist ./static

# Run as non-root; /data holds SQLite + uploads + figures + exports
RUN useradd -m -u 1000 kartothek \
    && mkdir -p /data \
    && chown -R kartothek:kartothek /data /app
USER kartothek

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=3)" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
