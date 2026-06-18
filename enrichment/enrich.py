"""
Property-size enrichment core.

Given a facility (lat/lng, or an address to geocode), estimate the total building
footprint square footage by:
  1. fetching the parcel polygon from Realie (1 API call),
  2. pulling Overture building footprints in that area straight from Overture's
     hosted S3 release (no local copy; auto-detects the latest monthly release),
  3. clipping the footprints to the parcel and summing their area.

Returns a result dict the caller writes to Airtable. Used by BOTH the nightly
batch (run_nightly.py) and — later — the inline "enrich now" search path.

Outcome semantics (critical for budget safety):
  transient=True  -> a temporary failure (Realie quota/HTTP error, network,
                     Overture/DuckDB error). Caller writes NOTHING so the record
                     stays eligible and is retried on a later run.
  transient=False -> a permanent outcome. Caller writes the size and/or a
                     Confidence status, so the record is never reprocessed.

Confidence values must match the Airtable single-select options:
  High | Review | No-Parcel | No-Coords | No-Footprint | Failed
"""
import os, re, json, math, urllib.parse, urllib.request, ssl

import duckdb, pyproj
from shapely import from_wkb
from shapely.geometry import shape, Point
from shapely.ops import transform as shp_transform, unary_union

try:
    import certifi
    _CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    _CTX = ssl._create_unverified_context()

GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
REALIE_API_KEY = os.environ.get("REALIE_API_KEY", "")

REALIE_URL = "https://app.realie.ai/api/public/property/location/"
REALIE_RADIUS_MI = 0.1      # ~160 m: captures the facility + immediate neighbors
REALIE_LIMIT = 60
M2_TO_FT2 = 10.7639
CLIP_OVERLAP = 0.5          # a building counts if >50% inside the parcel
ADJ_M = 3.0                 # parcels "adjacent" if within 3 m
BRIDGE_M = 20.0             # buildings "continuous" across a lot line if within 20 m
NEAREST_BLDG_M = 80.0       # fallback: re-anchor on a building within this many m of the pin


class TransientError(Exception):
    """Temporary failure — do not mark the record; retry later."""


# ---------------------------------------------------------------- HTTP helpers
def _get_json(url, headers=None, timeout=40):
    req = urllib.request.Request(url, headers=headers or {})
    return json.load(urllib.request.urlopen(req, context=_CTX, timeout=timeout))


def geocode(address):
    """Return (lat, lng) or None if the address is genuinely un-geocodable.
    Raises TransientError on a Google service/network error."""
    try:
        u = "https://maps.googleapis.com/maps/api/geocode/json?" + urllib.parse.urlencode(
            {"address": address, "key": GOOGLE_API_KEY})
        j = _get_json(u)
    except Exception as e:
        raise TransientError(f"geocode http: {e}")
    status = j.get("status")
    if status == "OK" and j.get("results"):
        loc = j["results"][0]["geometry"]["location"]
        return float(loc["lat"]), float(loc["lng"])
    if status in ("ZERO_RESULTS", "NOT_FOUND"):
        return None                      # permanent: no such place
    raise TransientError(f"geocode status {status}")   # OVER_QUERY_LIMIT etc.


def realie_parcels(lat, lng):
    """Return list of {geom(GeoJSON), owner, barea, use}. Raises TransientError
    on any HTTP failure (incl. quota), so the record is retried later."""
    q = urllib.parse.urlencode({"latitude": lat, "longitude": lng,
                                "radius": REALIE_RADIUS_MI, "limit": REALIE_LIMIT})
    try:
        j = _get_json(REALIE_URL + "?" + q, headers={"Authorization": REALIE_API_KEY})
    except Exception as e:
        raise TransientError(f"realie http: {e}")
    out = []
    for p in j.get("properties", []):
        g = p.get("geometry")
        if g:
            out.append({"geom": g, "owner": p.get("ownerName"),
                        "barea": p.get("buildingArea") or 0, "use": p.get("useCode")})
    return out


# ------------------------------------------------------- Overture (hosted S3)
_con = None
_release = None


def _release_path():
    """Auto-detect Overture's newest monthly release (override with OVERTURE_RELEASE)."""
    global _release
    if _release:
        return _release
    env = os.environ.get("OVERTURE_RELEASE")
    if env:
        _release = env
        return _release
    url = ("https://overturemaps-us-west-2.s3.amazonaws.com/"
           "?list-type=2&prefix=release/&delimiter=/")
    try:
        xml = urllib.request.urlopen(url, context=_CTX, timeout=20).read().decode()
        rels = re.findall(r"<Prefix>release/([^<]+)/</Prefix>", xml)
        _release = sorted(rels)[-1]
    except Exception as e:
        raise TransientError(f"overture release list: {e}")
    return _release


def _conn():
    """One warm DuckDB connection with object cache on, so only the FIRST
    Overture query per process pays the metadata read; the rest are fast."""
    global _con
    if _con is None:
        c = duckdb.connect()
        c.execute("INSTALL httpfs; LOAD httpfs;")
        c.execute("SET s3_region='us-west-2';")
        c.execute("SET enable_object_cache=true;")
        c.execute("SET enable_progress_bar=false;")
        _con = c
    return _con


def overture_footprints(minx, miny, maxx, maxy):
    """Footprint polygons (shapely, lat/lng) whose bbox intersects the box.
    Raises TransientError on any S3/DuckDB error."""
    s3 = (f"s3://overturemaps-us-west-2/release/{_release_path()}/"
          "theme=buildings/type=building/*")
    sql = f"""
        SELECT geometry FROM read_parquet('{s3}', hive_partitioning=1)
        WHERE bbox.xmin <= {maxx} AND bbox.xmax >= {minx}
          AND bbox.ymin <= {maxy} AND bbox.ymax >= {miny}
    """
    try:
        rows = _conn().execute(sql).fetchall()
    except Exception as e:
        raise TransientError(f"overture query: {e}")
    geoms = []
    for (wkb,) in rows:
        try:
            geoms.append(from_wkb(bytes(wkb)))
        except Exception:
            pass
    return geoms


# ------------------------------------------------------------------- geometry
def _utm_epsg(lng, lat):
    return (32600 if lat >= 0 else 32700) + int((lng + 180) / 6) + 1


def _norm_owner(s):
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def _parcel_buildings(parcel, buildings):
    out = set()
    for i, b in enumerate(buildings):
        if parcel.contains(b.centroid) or parcel.intersection(b).area > CLIP_OVERLAP * b.area:
            out.add(i)
    return out


def _result(transient=False, size=None, confidence=None, detail=""):
    return {"transient": transient, "size": size, "confidence": confidence, "detail": detail}


def enrich(lat=None, lng=None, address=None):
    """Estimate footprint sq ft for one facility. See module docstring for the
    outcome contract. Never raises — packages failures into the result dict."""
    try:
        # 1. resolve coordinates
        if lat is None or lng is None:
            if not address:
                return _result(False, None, "No-Coords", "no coords, no address")
            g = geocode(address)
            if g is None:
                return _result(False, None, "No-Coords", "ungeocodable address")
            lat, lng = g

        # 2. parcel(s) from Realie
        parcels = realie_parcels(lat, lng)
        if not parcels:
            return _result(False, None, "No-Parcel", "realie returned no parcels")

        proj = pyproj.Transformer.from_crs(
            "EPSG:4326", f"EPSG:{_utm_epsg(lng, lat)}", always_xy=True).transform
        pin = shp_transform(proj, Point(lng, lat))
        pcs = []
        for p in parcels:
            try:
                pcs.append({"g": shp_transform(proj, shape(p["geom"])),
                            "owner": p["owner"], "barea": p["barea"]})
            except Exception:
                pass
        if not pcs:
            return _result(False, None, "No-Parcel", "parcel geometry unparseable")

        # 3. Overture footprints across the parcels' bbox (in lat/lng for the query)
        bounds = [shape(p["geom"]).bounds for p in parcels]
        minx = min(b[0] for b in bounds) - 0.0004
        miny = min(b[1] for b in bounds) - 0.0004
        maxx = max(b[2] for b in bounds) + 0.0004
        maxy = max(b[3] for b in bounds) + 0.0004
        buildings_ll = overture_footprints(minx, miny, maxx, maxy)
        if not buildings_ll:
            return _result(False, None, "No-Footprint", "no overture buildings in parcel bbox")
        bg = [shp_transform(proj, b) for b in buildings_ll]

        # 4. pin parcel (contains the point, else nearest), clip, sum
        containing = [p for p in pcs if p["g"].contains(pin)]
        pin_p = containing[0] if containing else min(pcs, key=lambda p: p["g"].distance(pin))
        fb = _parcel_buildings(pin_p["g"], bg)
        fallback_used = False
        if not fb:
            # Pin landed on a building-less parcel (commonly the office lot while
            # the storage rows sit on an adjacent parcel). Re-anchor on the parcel
            # under the building nearest the pin, if it's close enough to belong.
            ni = min(range(len(bg)), key=lambda i: pin.distance(bg[i]))
            if pin.distance(bg[ni]) <= NEAREST_BLDG_M:
                host = [p for p in pcs if p["g"].contains(bg[ni].centroid)]
                if host:
                    pin_p = host[0]
                    fb = _parcel_buildings(pin_p["g"], bg)
                    fallback_used = True
            if not fb:
                return _result(False, None, "No-Footprint", "no footprints in pin parcel")
        size_ft2 = sum(bg[i].area for i in fb) * M2_TO_FT2

        # 5. confidence: single parcel = High; multi-parcel candidate = Review
        confidence = "High"
        po = _norm_owner(pin_p["owner"])
        if po:
            facp = [pin_p]; fbs = set(fb); seen = {id(pin_p)}
            while True:
                u = unary_union([p["g"] for p in facp]); added = False
                for p in pcs:
                    if id(p) in seen or _norm_owner(p["owner"]) != po:
                        continue
                    if p["g"].distance(u) > ADJ_M:
                        continue
                    qb = _parcel_buildings(p["g"], bg)
                    if not qb or not any(bg[i].distance(bg[j]) <= BRIDGE_M for i in qb for j in fbs):
                        continue
                    seen.add(id(p)); facp.append(p); fbs |= qb; added = True
                if not added:
                    break
            if len(facp) > 1:
                confidence = "Review"                 # spans multiple same-owner parcels
        # also flag for review if the assessor area wildly disagrees
        if confidence == "High" and pin_p["barea"]:
            ratio = size_ft2 / pin_p["barea"] if pin_p["barea"] else 1
            if ratio > 2 or ratio < 0.5:
                confidence = "Review"

        # a fallback re-anchor means the geocode missed the parcel — worth a glance
        if fallback_used and confidence == "High":
            confidence = "Review"
        detail = f"{len(fb)} bldg, release {_release}" + (" (nearest-bldg fallback)" if fallback_used else "")
        return _result(False, int(round(size_ft2)), confidence, detail)

    except TransientError as e:
        return _result(True, None, None, str(e))
    except Exception as e:                            # unexpected -> permanent Failed
        return _result(False, None, "Failed", f"{type(e).__name__}: {e}")
