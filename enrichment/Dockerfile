FROM python:3.11-slim

WORKDIR /app

# shapely / pyproj / duckdb ship self-contained manylinux wheels (GEOS/PROJ
# bundled), so no system geo libraries are needed.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the DuckDB httpfs extension at build time so runtime LOAD is
# fast and offline-safe (no per-cold-start extension fetch).
RUN python -c "import duckdb; c=duckdb.connect(); c.execute('INSTALL httpfs')"

COPY enrich.py run_nightly.py server.py ./

ENV PORT=8080
# 1 worker / 1 thread => one request at a time per instance, so the shared warm
# DuckDB connection is never used concurrently. Long timeout for /run-nightly.
CMD exec gunicorn --bind :$PORT --workers 1 --threads 1 --timeout 3600 server:app
