"""Ingestion, schema validation and policy guardrails.

The rulebook is loaded once, frozen (read-only) and hash-checked on every run.
The agent may only apply rules that exist in it; where it is silent the answer is
"refer to the inspector."
"""
import hashlib, json, re
from pathlib import Path
from types import MappingProxyType

DATA = Path(__file__).parent / "data"
RULEBOOK_FILE = DATA / "rulebook.json"
SCENARIO_FILE = DATA / "scenario.json"
INSPECTOR = "refer to the inspector."
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
VEHICLE_TYPES = ("bus", "freight", "personal")
SLOT_TYPES = ("bus_bay", "general")
RULE_TYPES = ("no_standing", "freight_window", "bus_bay_reserved")
ALLOWED_ACTIONS = ("keep", "reallocate", "delay", "reallocate_and_delay", "refer_to_inspector")
BANNED_RE = re.compile(r"\b(tow(ing|ed|s)?|impound\w*|clamp\w*|fines?|fined|penalt\w*|penali[sz]\w*|challan\w*|bye-?laws?|by-laws?|ordinances?)\b", re.I)


class SchemaError(ValueError):
    def __init__(self, errors):
        super().__init__("; ".join(errors))
        self.errors = errors


def m(t):
    h, mi = t.split(":")
    return int(h) * 60 + int(mi)


def hhmm(x):
    return f"{x // 60:02d}:{x % 60:02d}"


def _t(x): return isinstance(x, str) and bool(TIME_RE.match(x))
def _s(x): return isinstance(x, str) and bool(x.strip())
def _int(x): return isinstance(x, int) and not isinstance(x, bool)
def _num(x): return isinstance(x, (int, float)) and not isinstance(x, bool)


def freeze(x):
    if isinstance(x, dict):
        return MappingProxyType({k: freeze(v) for k, v in x.items()})
    if isinstance(x, list):
        return tuple(freeze(v) for v in x)
    return x


# ---------------- rulebook ----------------
def validate_rulebook(rb):
    e = []
    if not isinstance(rb, dict):
        return ["rulebook must be a JSON object"]
    if not _s(rb.get("version")): e.append("version must be a string")
    if rb.get("immutable") is not True: e.append("immutable must be true")
    fa = rb.get("forbidden_actions")
    if not isinstance(fa, list) or not any("tow" in str(x) for x in fa) or not any("impound" in str(x) for x in fa):
        e.append("forbidden_actions must include towing and impoundment")
    rules = rb.get("rules")
    if not isinstance(rules, list) or not rules:
        return e + ["rules must be a non-empty list"]
    seen = set()
    for i, r in enumerate(rules):
        p = f"rules[{i}]"
        if not isinstance(r, dict):
            e.append(f"{p} must be an object"); continue
        rid = r.get("id")
        if not _s(rid): e.append(f"{p}.id missing")
        elif rid in seen: e.append(f"{p}.id duplicate {rid}")
        else: seen.add(rid)
        t = r.get("type")
        if t not in RULE_TYPES: e.append(f"{p}.type must be one of {RULE_TYPES}")
        if not _s(r.get("text")): e.append(f"{p}.text missing")
        vt = r.get("vehicle_types")
        if not isinstance(vt, list) or not vt or any(v not in VEHICLE_TYPES for v in vt):
            e.append(f"{p}.vehicle_types must be a non-empty subset of {VEHICLE_TYPES}")
        if t in ("no_standing", "freight_window"):
            for k in ("start", "end"):
                if not _t(r.get(k)): e.append(f"{p}.{k} must be HH:MM")
            if _t(r.get("start")) and _t(r.get("end")) and m(r["start"]) >= m(r["end"]):
                e.append(f"{p}: start must be before end")
        if t == "bus_bay_reserved":
            st = r.get("slot_types")
            if not isinstance(st, list) or not st or any(s not in SLOT_TYPES for s in st):
                e.append(f"{p}.slot_types must be a non-empty subset of {SLOT_TYPES}")
    return e


def load_rulebook():
    raw = RULEBOOK_FILE.read_bytes()
    rb = json.loads(raw)
    errs = validate_rulebook(rb)
    if errs:
        raise SchemaError(["rulebook.json: " + x for x in errs])
    return rb, hashlib.sha256(raw).hexdigest()


RULEBOOK, RULEBOOK_HASH = load_rulebook()
RULES = freeze(RULEBOOK["rules"])           # read-only: mutation raises TypeError


def verify_rulebook():
    """True while the rulebook on disk is byte-identical to what was loaded."""
    try:
        return hashlib.sha256(RULEBOOK_FILE.read_bytes()).hexdigest() == RULEBOOK_HASH
    except Exception:
        return False


# ---------------- scenario ----------------
def validate_booking(b, sc, prefix="booking"):
    if not isinstance(b, dict):
        return [f"{prefix} must be an object"]
    e = []
    slots = {s["id"] for s in sc.get("slots", []) if isinstance(s, dict) and _s(s.get("id"))}
    pw = sc.get("plan_window") or {}
    for k in ("vendor", "phone"):
        if not _s(b.get(k)): e.append(f"{prefix}.{k} must be a non-empty string")
    if b.get("vehicle_type") not in VEHICLE_TYPES: e.append(f"{prefix}.vehicle_type must be one of {VEHICLE_TYPES}")
    if not (_s(b.get("slot_id")) and b["slot_id"] in slots): e.append(f"{prefix}.slot_id must be one of {sorted(slots)}")
    if not _t(b.get("start")): e.append(f"{prefix}.start must be HH:MM")
    d = b.get("duration")
    if not _int(d) or not 5 <= d <= 180: e.append(f"{prefix}.duration must be an integer 5-180")
    if _t(b.get("start")) and _int(d) and _t(pw.get("start")) and _t(pw.get("end")):
        if m(b["start"]) < m(pw["start"]) or m(b["start"]) + d > m(pw["end"]):
            e.append(f"{prefix} must lie inside the plan window {pw['start']}-{pw['end']}")
    return e


def validate_incident(i, sc):
    e = []
    slots = {s["id"] for s in sc.get("slots", [])}
    if not (_s(i.get("slot_id")) and i["slot_id"] in slots): e.append(f"slot_id must be one of {sorted(slots)}")
    if not _t(i.get("start")): e.append("start must be HH:MM")
    if not _int(i.get("duration")) or not 5 <= i["duration"] <= 180: e.append("duration must be an integer 5-180")
    return e


def validate_scenario(sc):
    if not isinstance(sc, dict):
        return ["scenario must be a JSON object"]
    e = []
    def chk(c, msg):
        if not c: e.append(msg)
        return c
    chk(_s(sc.get("campus")), "campus must be a non-empty string")
    cl = sc.get("curb_length_m")
    chk(_num(cl) and cl > 0, "curb_length_m must be a positive number")
    pw, w0, w1 = sc.get("plan_window"), None, None
    if chk(isinstance(pw, dict) and _t(pw.get("start")) and _t(pw.get("end")), "plan_window.start/end must be HH:MM"):
        w0, w1 = m(pw["start"]), m(pw["end"])
        chk(w1 - w0 == 360, "plan_window must span exactly 6 hours (360 minutes)")
    ids, total = set(), 0
    slots = sc.get("slots")
    if chk(isinstance(slots, list) and slots, "slots must be a non-empty list"):
        for i, s in enumerate(slots):
            p = f"slots[{i}]"
            if not chk(isinstance(s, dict), f"{p} must be an object"): continue
            sid = s.get("id")
            if chk(_s(sid), f"{p}.id missing"):
                chk(sid not in ids, f"{p}.id duplicate {sid}"); ids.add(sid)
            chk(s.get("type") in SLOT_TYPES, f"{p}.type must be one of {SLOT_TYPES}")
            chk(_s(s.get("label")), f"{p}.label missing")
            chk(_num(s.get("length_m")) and s["length_m"] > 0, f"{p}.length_m must be a positive number")
            chk(_int(s.get("capacity")) and s["capacity"] >= 1, f"{p}.capacity must be an integer >= 1")
            if _num(s.get("length_m")): total += s["length_m"]
        if _num(cl): chk(total <= cl + 1e-9, f"slots total {total} m exceeds the {cl} m curb boundary")
        chk(any(isinstance(s, dict) and s.get("type") == "bus_bay" for s in slots), "at least one bus_bay slot is required")
    ex = sc.get("school_exit")
    if chk(isinstance(ex, list), "school_exit must be a list"):
        for i, x in enumerate(ex):
            p = f"school_exit[{i}]"
            if not chk(isinstance(x, dict) and _t(x.get("start")) and _t(x.get("end")), f"{p}.start/end must be HH:MM"): continue
            chk(m(x["start"]) < m(x["end"]), f"{p}: start must be before end")
            chk(_int(x.get("expected_cars", 0)) and x.get("expected_cars", 0) >= 0, f"{p}.expected_cars must be an integer >= 0")
    bt = sc.get("bus_trace")
    if chk(isinstance(bt, list), "bus_trace must be a list"):
        for i, b in enumerate(bt):
            p = f"bus_trace[{i}]"
            if not chk(isinstance(b, dict), f"{p} must be an object"): continue
            chk(_s(b.get("id")), f"{p}.id missing")
            chk(_s(b.get("destination")), f"{p}.destination missing")
            ok = chk(_t(b.get("arrives")), f"{p}.arrives must be HH:MM")
            okd = chk(_int(b.get("dwell_min")) and 1 <= b["dwell_min"] <= 60, f"{p}.dwell_min must be an integer 1-60")
            chk(_int(b.get("delay_if_blocked_min")) and b["delay_if_blocked_min"] >= 0, f"{p}.delay_if_blocked_min must be an integer >= 0")
            if ok and okd and w0 is not None:
                chk(w0 <= m(b["arrives"]) and m(b["arrives"]) + b["dwell_min"] <= w1, f"{p} must lie inside the plan window")
    bk = sc.get("bookings")
    if chk(isinstance(bk, list), "bookings must be a list"):
        seen = set()
        for i, b in enumerate(bk):
            e += validate_booking(b, sc, f"bookings[{i}]")
            if isinstance(b, dict):
                chk(_s(b.get("id")), f"bookings[{i}].id missing")
                chk(b.get("id") not in seen, f"bookings[{i}].id duplicate {b.get('id')}"); seen.add(b.get("id"))
    rt = sc.get("routes", {})
    chk(isinstance(rt, dict) and all(k in ids and _s(v) for k, v in rt.items()), "routes must map existing slot ids to text")
    bd = sc.get("bus_dispatch")
    chk(isinstance(bd, dict) and _s(bd.get("name")) and _s(bd.get("phone")), "bus_dispatch needs name and phone")
    return e


def load_scenario_file():
    sc = json.loads(SCENARIO_FILE.read_text())
    errs = validate_scenario(sc)
    if errs:
        raise SchemaError(["scenario.json: " + x for x in errs])
    return sc


# ---------------- policy evaluation & guardrails ----------------
def overlap(a0, a1, b0, b1):
    return a0 < b1 and b0 < a1


def evaluate(vehicle_type, slot_type, start, end, curfew_overrides=None):
    """Return (applicable_rules, violated_rules). No applicable rule = the rulebook is silent."""
    app, viol = [], []
    for r in RULES:
        t = r["type"]
        if t == "no_standing":
            if vehicle_type in r["vehicle_types"] and overlap(start, end, m(r["start"]), m(r["end"])):
                app.append(r); viol.append(r)
        elif t == "freight_window":
            if vehicle_type in r["vehicle_types"]:
                freight_start = (curfew_overrides or {}).get("freight_window", {}).get("start", r["start"])
                freight_end = (curfew_overrides or {}).get("freight_window", {}).get("end", r["end"])
                effective_rule = r
                if "freight_window" in (curfew_overrides or {}):
                    effective_rule = {**r, "start": freight_start, "end": freight_end,
                                      "text": f"Operational freight window is {freight_start}-{freight_end} (R2)."}
                app.append(effective_rule)
                if not (m(freight_start) <= start and end <= m(freight_end)):
                    viol.append(effective_rule)
        elif t == "bus_bay_reserved":
            if slot_type in r["slot_types"]:
                app.append(r)
                if vehicle_type not in r["vehicle_types"]:
                    viol.append(r)
    return app, viol


def guard_action(a):
    """Every action must be a permitted type, cite only real rules and carry no enforcement wording."""
    ids = {r["id"] for r in RULES}
    if a.get("action") not in ALLOWED_ACTIONS:
        return False, f"action '{a.get('action')}' is not permitted"
    for r in a.get("reasons", []):
        if r["rule"] not in ids and r["rule"] not in ("data", "none"):
            return False, f"cites unknown rule {r['rule']}"
    blob = " ".join([str(a.get("reroute") or "")] + [r["text"] for r in a.get("reasons", [])])
    if BANNED_RE.search(blob):
        return False, "contains prohibited enforcement wording"
    return True, ""


def guard_text(text):
    """Used on every LLM-written message: no towing/penalties/bye-laws and no invented rule ids."""
    if BANNED_RE.search(text):
        return False, "prohibited enforcement wording (towing / penalty / bye-law)"
    ids = {r["id"] for r in RULES}
    for rid in re.findall(r"\bR\d+\b", text):
        if rid not in ids:
            return False, f"invented rule {rid}"
    return True, ""