"""
Nightly enrichment runner.

Selects the backlog from Airtable (Storage facilities with no measured value,
no Overture value, and no Overture confidence yet), enriches each via enrich.py,
and writes the result back. Designed to be triggered by Cloud Scheduler, but
runs anywhere the env vars are set.

SAFETY: ENRICH_LIMIT caps how many records a run will touch. It defaults to 2 so
the job CANNOT run on the whole backlog by accident. Set ENRICH_LIMIT=0 for
unlimited (full backlog) only when you're deliberately ready.

Env:
  AIRTABLE_ACCESS_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID (default Accounts)
  GOOGLE_API_KEY, REALIE_API_KEY
  ENRICH_LIMIT      (default 2; 0 = unlimited)
  DRY_RUN           ("1" = compute but do NOT write to Airtable)
"""
import os, json, time, urllib.parse, urllib.request, ssl

import enrich as E

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    CTX = ssl._create_unverified_context()

TOKEN = os.environ["AIRTABLE_ACCESS_TOKEN"]
BASE = os.environ["AIRTABLE_BASE_ID"]
TABLE = os.environ.get("AIRTABLE_TABLE_ID", "tblWDvEfAkT9Qq7OC")
LIMIT = int(os.environ.get("ENRICH_LIMIT", "2"))
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"

SELECT = ('AND({Asset Class}="Storage", {Property Size Measured}=BLANK(), '
          '{Property Size Overture}=BLANK(), {Property Size Overture Confidence}=BLANK(), '
          'NOT({Exclude from Overture Enrichment}))')
FIELDS = ["Name", "Coordinates", "Address", "City", "State", "Zip"]


def _req(url, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    return json.load(urllib.request.urlopen(req, context=CTX, timeout=40))


def fetch_candidates(limit):
    """Return up to `limit` backlog records (limit<=0 means all)."""
    recs, offset = [], None
    while True:
        page = 100 if limit <= 0 else min(100, limit - len(recs))
        qs = [("filterByFormula", SELECT), ("pageSize", str(page))]
        for f in FIELDS:
            qs.append(("fields[]", f))
        if offset:
            qs.append(("offset", offset))
        d = _req(f"https://api.airtable.com/v0/{BASE}/{TABLE}?" + urllib.parse.urlencode(qs))
        recs += d["records"]
        offset = d.get("offset")
        if not offset or (limit > 0 and len(recs) >= limit):
            break
    return recs[:limit] if limit > 0 else recs


def patch_record(rec_id, fields, dry_run=False):
    if dry_run:
        return
    _req(f"https://api.airtable.com/v0/{BASE}/{TABLE}/{rec_id}", method="PATCH",
         body={"fields": fields})


def coords_of(f):
    c = (f.get("Coordinates") or "")
    if c.count(",") == 1:
        try:
            return float(c.split(",")[0]), float(c.split(",")[1])
        except Exception:
            pass
    return None, None


def address_of(f):
    parts = [f.get("Address"), f.get("City"), f.get("State"), str(f.get("Zip") or "")]
    return ", ".join(x for x in parts if x) or None


def run(limit, dry_run=False):
    """Enrich up to `limit` backlog records (limit<=0 = all). Returns a stats
    dict. Used by the CLI (main) and the Cloud Run /run-nightly endpoint."""
    print(f"=== enrichment run: limit={limit or 'ALL'} dry_run={dry_run} ===", flush=True)
    cands = fetch_candidates(limit)
    print(f"selected {len(cands)} backlog record(s)\n", flush=True)

    stats = {"selected": len(cands), "written": 0, "failed_marked": 0,
             "skipped_transient": 0, "stopped_on_quota": False}
    t0 = time.time()
    for rec in cands:
        rid, f = rec["id"], rec["fields"]
        name = (f.get("Name") or "?")[:34]
        lat, lng = coords_of(f)
        addr = address_of(f)

        ts = time.time()
        res = E.enrich(lat=lat, lng=lng, address=addr)
        dt = time.time() - ts

        if res["transient"]:
            stats["skipped_transient"] += 1
            print(f"  ~ {name:34} TRANSIENT (not marked, will retry): {res['detail']}", flush=True)
            if any(k in res["detail"] for k in ("429", "402", "quota")):
                print("  !! Realie quota/limit hit — stopping run; remaining records retry next time.", flush=True)
                stats["stopped_on_quota"] = True
                break
            continue

        fields = {}
        if res["size"] is not None:
            fields["Property Size Overture"] = res["size"]
        if res["confidence"]:
            fields["Property Size Overture Confidence"] = res["confidence"]
        try:
            patch_record(rid, fields, dry_run)
        except Exception as e:
            stats["skipped_transient"] += 1
            print(f"  ~ {name:34} airtable write failed (will retry): {e}", flush=True)
            continue

        if res["size"] is not None:
            stats["written"] += 1
            print(f"  + {name:34} {res['size']:>9,} sqft  [{res['confidence']}]  ({dt:.1f}s)  {res['detail']}", flush=True)
        else:
            stats["failed_marked"] += 1
            print(f"  - {name:34} {res['confidence']:<12} (marked, won't retry)  {res['detail']}", flush=True)

    stats["seconds"] = round(time.time() - t0)
    print(f"\n=== done in {stats['seconds']}s | sized: {stats['written']}  "
          f"marked-no-result: {stats['failed_marked']}  skipped-transient: {stats['skipped_transient']} ===", flush=True)
    return stats


def main():
    run(LIMIT, DRY_RUN)


if __name__ == "__main__":
    main()
