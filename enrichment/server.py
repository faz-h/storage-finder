"""
Cloud Run service exposing the enrichment core. Two callers share this one
service (and its warm DuckDB connection):

  POST /enrich       -> inline "enrich now" path from the Storage Finder UI.
                        Body: {"records":[{"id":..,"lat":..,"lng":..,"address":..}]}
                        Returns: {"results":[{"id":..,"size":..,"confidence":..,
                                               "transient":..,"detail":..}, ...]}
  POST /run-nightly  -> the nightly batch (triggered by Cloud Scheduler).
                        Body (optional): {"limit": <int>}  (default env ENRICH_LIMIT, 0=all)
                        Returns: the run stats dict.
  GET  /health       -> liveness probe.

Auth: if ENRICH_SHARED_TOKEN is set, both POST routes require a matching
`X-Enrich-Token` header (Cloud Scheduler and the App Engine app send it).
"""
import os
from flask import Flask, request, jsonify

import enrich as E
import run_nightly as RN

app = Flask(__name__)
SHARED_TOKEN = os.environ.get("ENRICH_SHARED_TOKEN", "")


def _authorized():
    if not SHARED_TOKEN:
        return True
    return request.headers.get("X-Enrich-Token") == SHARED_TOKEN


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.post("/enrich")
def enrich_batch():
    if not _authorized():
        return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(force=True, silent=True) or {}
    records = body.get("records", [])
    if not isinstance(records, list):
        return jsonify({"error": "records must be a list"}), 400
    results = []
    for r in records:
        res = E.enrich(lat=r.get("lat"), lng=r.get("lng"), address=r.get("address"))
        results.append({"id": r.get("id"), **res})
    return jsonify({"results": results})


@app.post("/run-nightly")
def run_nightly():
    if not _authorized():
        return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(force=True, silent=True) or {}
    limit = int(body.get("limit", os.environ.get("ENRICH_LIMIT", "0")))
    stats = RN.run(limit=limit, dry_run=False)
    return jsonify(stats)


if __name__ == "__main__":
    # local dev only; production uses gunicorn (see Dockerfile)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
