import hashlib, json, os, re, secrets, time
from copy import deepcopy
from pathlib import Path
import requests
from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import engine, policy
from policy import INSPECTOR, RULEBOOK, RULEBOOK_HASH

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "llama3.2:3b"
STATE_FILE = Path(os.getenv("CURB_STATE_FILE", str(Path(__file__).parent / "state.json")))
app = FastAPI(title="Bus-priority & curb-window agent")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ---------- auth (demo-grade: salted hash + in-memory session tokens; single account) ----------
def _h(p): return hashlib.sha256(("curb-salt:" + p).encode()).hexdigest()
USERS = {"admin": _h("curb@2026")}
SESSIONS = {}

def current_user(authorization: str = Header(None)):
    tok = (authorization or "").replace("Bearer ", "")
    if tok not in SESSIONS:
        raise HTTPException(401, "Login required")
    return SESSIONS[tok]

# ---------- state (saved to state.json so a restart does not lose your work) ----------
STATE = {}
KEYS = ("scenario", "bookings", "incidents", "outbox", "plan", "steps", "insights", "log", "guard_log")

def reset_state(scenario=None):
    sc = deepcopy(scenario) if scenario else policy.load_scenario_file()
    operator_profile = STATE.get("operator_profile")
    STATE.clear()
    STATE.update(scenario=sc, bookings=deepcopy(sc["bookings"]), incidents=[], outbox=[], plan=None, steps=[],
                 insights=None, log=[], guard_log=[], curfew_overrides={}, inspector_decisions={},
                 dwell_history={}, live_gps=[], traffic={},
                 traffic_base_arrivals=[b["arrives"] for b in sc["bus_trace"]],
                 traffic_base_starts={b["id"]: b["start"] for b in sc["bookings"]},
                 operator_profile=operator_profile, last_agent_briefing=None)

def save_state():
    try:
        STATE_FILE.write_text(json.dumps(STATE))
    except Exception:
        pass

def load_state():
    try:
        data = json.loads(STATE_FILE.read_text())
        if not all(k in data for k in KEYS) or policy.validate_scenario(data["scenario"]):
            return False
        data.setdefault("curfew_overrides", {})
        data.setdefault("inspector_decisions", {})
        data.setdefault("dwell_history", {})
        data.setdefault("live_gps", [])
        data.setdefault("traffic", {})
        data.setdefault("traffic_base_arrivals", [b["arrives"] for b in data["scenario"]["bus_trace"]])
        data.setdefault("traffic_base_starts", {b["id"]: b["start"] for b in data["bookings"]})
        data.setdefault("operator_profile", None)
        data.setdefault("last_agent_briefing", None)
        STATE.clear(); STATE.update(data)
        return True
    except Exception:
        return False

if not load_state():
    reset_state()

def log(user, event):
    STATE["log"] = (STATE["log"] + [{"ts": time.strftime("%H:%M:%S"), "user": user["name"], "event": event}])[-200:]
    audit_event("operator_event", {"event": event}, user.get("name"))
    save_state()

def audit_event(event_type, payload, user=None):
    endpoint = os.getenv("PRISMA_AUDIT_URL", "http://127.0.0.1:8100/audit")
    try:
        requests.post(endpoint, json={"eventType": event_type, "user": user or "system", "payload": payload}, timeout=0.25)
    except requests.RequestException:
        pass

def guard_note(kind, reason, text):
    STATE["guard_log"] = (STATE["guard_log"] + [{"ts": time.strftime("%H:%M:%S"), "kind": kind, "reason": reason, "snippet": (text or "")[:90]}])[-100:]

# ---------- LLM (llama3.2:3b through Ollama) ----------
def llm(prompt, tokens=90):
    try:
        r = requests.post(OLLAMA_URL, json={"model": MODEL, "prompt": prompt, "stream": False,
                          "options": {"temperature": 0.2, "num_predict": tokens}}, timeout=60)
        return r.json()["response"].strip()
    except Exception:
        return None

def slot_desc(sc, slot_id):
    s = next(x for x in sc["slots"] if x["id"] == slot_id)
    a, b = engine.meters(sc)[slot_id]
    return f"{s['label']} ({a:g}-{b:g} m of the curb)"

def checked_llm(kind, prompt, must_have, tokens=90):
    """LLM text is accepted only if it contains the facts we need and passes the policy guardrail."""
    text = llm(prompt, tokens)
    if not text:
        return None
    text = text.strip('"')
    ok, why = policy.guard_text(text)
    if not ok:
        guard_note(kind, why, text); return None
    if len(text) > 320 or not all(x in text for x in must_have):
        return None
    return text

def tempo_sms(sc, a, use_llm):
    ids = ", ".join(r["rule"] for r in a["reasons"] if r["rule"].startswith("R")) or "the curb plan"
    lane = sc.get("routes", {}).get(a["slot"], "")
    old, new = slot_desc(sc, a["old_slot"]), slot_desc(sc, a["slot"])
    fallback = (f"Hi {a['vendor']}: the bus bay is reserved for buses at {a['old_start']}. Your tempo is moved to {new} "
                f"at {a['new_start']} ({a['duration']} min){' via ' + lane if lane else ''}, under rule {ids}. Reply OK to confirm.")
    text = None
    if use_llm:
        text = checked_llm("tempo_sms",
            f"Write ONE short SMS (under 240 characters) to a delivery tempo driver.\nFacts: the bus bay is reserved for buses; "
            f"old slot: {old} at {a['old_start']}; new slot: {new} at {a['new_start']}; lane: {lane}; rule: {ids}.\n"
            f"Tell the driver where to go and when so they do not circle the gate. Ask them to reply OK. "
            f"Use only these facts. No penalties, fines or towing.\nOutput only the SMS.", [a["new_start"]])
    return text or fallback, (MODEL if text else "template")

def dispatch_sms(sc, plan, use_llm):
    risky = [r for r in plan["buses"] if r["blocked_by"] or r["school_bus"]]
    if not risky:
        return None
    bay = next(s for s in sc["slots"] if s["type"] == "bus_bay")
    listing = ", ".join(f"{r['bus']} {r['arrives']} ({r['destination']})" for r in risky)
    out = [a["vendor"] for a in plan["actions"] if a["status"] == "moved" and a["old_slot"] == bay["id"]]
    moved = f" {', '.join(out)} moved out of the bay." if out else ""
    fallback = (f"{sc['bus_dispatch']['name']}: the {bay['label'].lower()} ({slot_desc(sc, bay['id']).split('(')[1]} is reserved for buses. "
                f"Kept clear for {listing}.{moved} No action needed; reply OK to acknowledge.")
    text = None
    if use_llm:
        text = checked_llm("dispatch_sms",
            f"Write ONE short confirmation SMS (under 260 characters) to school bus dispatch.\nFacts: the bus bay is reserved for buses "
            f"and kept clear for: {listing}.{moved}\nUse only these facts. No penalties, fines or towing.\nOutput only the SMS.",
            [r["bus"] for r in risky], 110)
    return text or fallback, (MODEL if text else "template"), risky

def deliver(phone, text):
    sid, tok, frm = os.getenv("TWILIO_SID"), os.getenv("TWILIO_TOKEN"), os.getenv("TWILIO_FROM")
    if sid and tok and frm:
        try:
            r = requests.post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                              data={"To": phone.replace(" ", ""), "From": frm, "Body": text}, auth=(sid, tok), timeout=15)
            return ("twilio", r.status_code < 300)
        except Exception:
            return ("twilio", False)
    return ("mock-gateway", True)

# ---------- models ----------
class Login(BaseModel): username: str; password: str
class ProfileIn(BaseModel): full_name: str; role: str; email: str; phone: str; organization: str
class BookingIn(BaseModel): vendor: str; phone: str = "+91 90000 00000"; vehicle_type: str = "freight"; slot_id: str; start: str; duration: int
class IncidentIn(BaseModel): slot_id: str; start: str; duration: int; reason: str = "Vehicle blocking"
class AskReq(BaseModel): question: str
class CheckReq(BaseModel): vehicle_type: str; slot_id: str; start: str; duration: int
class IngestReq(BaseModel): scenario: dict; dry_run: bool = False
class CurfewIn(BaseModel): start: str; end: str
class InspectorIn(BaseModel): decision: str; slot_id: str | None = None; start: str | None = None
class DwellIn(BaseModel): bus: str; dwell_min: int
class ReplyIn(BaseModel): message: str = "OK"
class SendIn(BaseModel): current_time: str | None = None
class RunReq(BaseModel): use_llm: bool = True; auto_reply: bool = True; current_time: str | None = None

# ---------- auth routes ----------
@app.post("/api/login")
def login(req: Login):
    pw = USERS.get(req.username)
    if not pw or not secrets.compare_digest(pw, _h(req.password)):
        raise HTTPException(401, "Invalid username or password")
    tok = secrets.token_hex(16)
    SESSIONS[tok] = {"name": req.username, "profile": deepcopy(STATE.get("operator_profile"))}
    return {"token": tok, "name": req.username}

@app.post("/api/profile")
def save_profile(req: ProfileIn, u=Depends(current_user)):
    profile = {key: value.strip() for key, value in req.model_dump().items()}
    if not all(profile.values()):
        raise HTTPException(422, "All operator profile fields are required")
    if len(profile["full_name"]) > 100 or len(profile["organization"]) > 120:
        raise HTTPException(422, "Name or organization is too long")
    u["profile"] = profile
    STATE["operator_profile"] = profile
    save_state()
    return {"user": u}

@app.post("/api/logout")
def logout(authorization: str = Header(None)):
    SESSIONS.pop((authorization or "").replace("Bearer ", ""), None)
    return {"ok": True}

# ---------- state / ingestion ----------
def public_state(u):
    sc = STATE["scenario"]
    return {**{k: v for k, v in sc.items() if k != "bookings"},
            "rules": RULEBOOK["rules"],
            "rulebook": {"version": RULEBOOK["version"], "hash": RULEBOOK_HASH, "hash_verified": policy.verify_rulebook(),
                         "immutable": True, "forbidden_actions": RULEBOOK["forbidden_actions"]},
            **{k: STATE[k] for k in ("bookings", "incidents", "outbox", "plan", "steps", "insights", "guard_log")},
            **{k: STATE[k] for k in ("curfew_overrides", "inspector_decisions", "dwell_history", "live_gps", "traffic")},
            "last_agent_briefing": STATE["last_agent_briefing"],
            "log": STATE["log"][-25:], "user": u}

def replan_state():
    sc = STATE["scenario"]
    STATE["plan"] = engine.make_plan(sc, STATE["bookings"], STATE["incidents"], STATE["curfew_overrides"],
                                    STATE["inspector_decisions"], STATE["dwell_history"])
    STATE["insights"] = engine.insights(sc, STATE["plan"])
    STATE["insights"]["briefing"] = "Plan recalculated using live traffic, inspector decisions, curfew settings, and dwell history."
    STATE["insights"]["briefing_source"] = "system"
    save_state()
    return STATE["plan"]

@app.get("/api/state")
def state(u=Depends(current_user)):
    return public_state(u)

@app.get("/api/audit/daily")
def daily_audit_report(date: str | None = None, u=Depends(current_user)):
    endpoint = os.getenv("PRISMA_AUDIT_REPORT_URL", "http://127.0.0.1:8100/reports/daily")
    try:
        response = requests.get(endpoint, params={"date": date} if date else {}, timeout=2)
        response.raise_for_status()
        return response.json()
    except requests.RequestException as exc:
        raise HTTPException(503, "Prisma audit service is unavailable; start audit-service and configure PostgreSQL.") from exc

@app.get("/api/scenario")
def get_scenario(u=Depends(current_user)):
    return {**STATE["scenario"], "bookings": STATE["bookings"]}

@app.get("/api/validate")
def validate(u=Depends(current_user)):
    sc = {**STATE["scenario"], "bookings": STATE["bookings"]}
    errs = policy.validate_scenario(sc)
    return {"rulebook": {"ok": True, "version": RULEBOOK["version"], "hash": RULEBOOK_HASH,
                         "hash_verified": policy.verify_rulebook(), "rules": len(RULEBOOK["rules"])},
            "scenario": {"ok": not errs, "errors": errs,
                         "counts": {"slots": len(sc["slots"]), "bus_trace": len(sc["bus_trace"]), "bookings": len(sc["bookings"]),
                                    "school_exit": len(sc["school_exit"])},
                         "curb_length_used_m": sum(s["length_m"] for s in sc["slots"]), "curb_length_m": sc["curb_length_m"],
                         "plan_window": sc["plan_window"]},
            "checked": ["timestamps are HH:MM", "vehicle types are bus / freight / personal", "slot types are bus_bay / general",
                        "slot lengths fit the curb boundary", "plan window is exactly 6 hours", "bookings and buses lie inside the window"]}

@app.put("/api/curfews/freight-window")
def set_freight_window(req: CurfewIn, u=Depends(current_user)):
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", req.start) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", req.end):
        raise HTTPException(422, "Curfew times must use HH:MM")
    start, end = policy.m(req.start), policy.m(req.end)
    window = STATE["scenario"]["plan_window"]
    if start >= end or start < policy.m(window["start"]) or end > policy.m(window["end"]):
        raise HTTPException(422, "Freight window must be ordered and inside the six-hour plan")
    STATE["curfew_overrides"]["freight_window"] = {"start": req.start, "end": req.end}
    plan = replan_state()
    log(u, f"Changed operational freight window to {req.start}-{req.end}; plan recalculated")
    audit_event("curfew_override", {"start": req.start, "end": req.end}, u["name"])
    return {"plan": plan, "curfew_overrides": STATE["curfew_overrides"]}

@app.post("/api/inspector/{bid}")
def inspector_decision(bid: str, req: InspectorIn, u=Depends(current_user)):
    booking = next((b for b in STATE["bookings"] if b["id"] == bid), None)
    if not booking:
        raise HTTPException(404, "Booking not found")
    if req.decision not in ("approved", "rejected"):
        raise HTTPException(422, "decision must be approved or rejected")
    decision = {"decision": req.decision}
    if req.decision == "approved":
        slot_id, start = req.slot_id or booking["slot_id"], req.start or booking["start"]
        if slot_id not in {s["id"] for s in STATE["scenario"]["slots"]}:
            raise HTTPException(422, "Unknown curb slot")
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", start):
            raise HTTPException(422, "Start time must use HH:MM")
        decision.update(slot_id=slot_id, start=start)
    STATE["inspector_decisions"][bid] = decision
    plan = replan_state()
    log(u, f"Inspector {req.decision} booking {bid}")
    audit_event("inspector_decision", {"bookingId": bid, **decision}, u["name"])
    return {"plan": plan, "inspector_decisions": STATE["inspector_decisions"]}

@app.post("/api/buses/dwell")
def record_dwell(req: DwellIn, u=Depends(current_user)):
    if not any(b["id"] == req.bus for b in STATE["scenario"]["bus_trace"]):
        raise HTTPException(404, "Bus not found in the current scenario")
    if not 1 <= req.dwell_min <= 180:
        raise HTTPException(422, "Observed dwell must be between 1 and 180 minutes")
    observations = STATE["dwell_history"].setdefault(req.bus, [])
    observations.append(req.dwell_min)
    STATE["dwell_history"][req.bus] = observations[-50:]
    plan = replan_state()
    log(u, f"Recorded {req.dwell_min}-minute dwell for {req.bus}; plan recalculated")
    audit_event("bus_dwell_observation", req.model_dump(), u["name"])
    return {"plan": plan, "dwell_history": STATE["dwell_history"]}

@app.websocket("/api/ws/live")
async def live_gps(websocket: WebSocket):
    token = websocket.query_params.get("token", "")
    if token not in SESSIONS:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    try:
        while True:
            point = await websocket.receive_json()
            if not isinstance(point, dict):
                await websocket.send_json({"type": "error", "message": "GPS update must be an object"})
                continue
            lat, lon = point.get("lat"), point.get("lon")
            if point.get("vehicle_type") not in ("bus", "freight", "personal") or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or not (-90 <= lat <= 90 and -180 <= lon <= 180):
                await websocket.send_json({"type": "error", "message": "Invalid GPS update"})
                continue
            raw_delay = point.get("delay_min")
            speed = point.get("speed_kmh")
            if isinstance(raw_delay, (int, float)) and not isinstance(raw_delay, bool):
                delay = max(0, min(90, round(raw_delay)))
            elif isinstance(speed, (int, float)) and not isinstance(speed, bool):
                delay = 12 if speed < 8 else 6 if speed < 18 else 3 if speed < 28 else 0
            else:
                delay = {"heavy": 12, "moderate": 6, "slow": 3, "free": 0}.get(str(point.get("traffic_level", "free")).lower(), 0)
            level = str(point.get("traffic_level") or ("heavy" if delay >= 10 else "moderate" if delay >= 5 else "slow" if delay else "free"))
            event = {"vehicle_id": str(point.get("vehicle_id", "unknown")), "vehicle_type": point["vehicle_type"],
                     "lat": lat, "lon": lon, "gate": str(point.get("gate", "Gate 2")), "speed_kmh": speed,
                     "traffic_level": level, "delay_min": delay, "received_at": time.strftime("%H:%M:%S")}
            STATE["live_gps"] = (STATE["live_gps"] + [event])[-100:]
            simulation_time = point.get("simulation_time", STATE["scenario"]["plan_window"]["start"])
            if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", str(simulation_time)):
                simulation_time = STATE["scenario"]["plan_window"]["start"]
            changed_schedule = False
            target_time = None
            if event["vehicle_type"] == "bus":
                base_arrivals = STATE["traffic_base_arrivals"]
                candidates = [(i, bus, base_arrivals[i]) for i, bus in enumerate(STATE["scenario"]["bus_trace"])
                              if bus["id"] == event["vehicle_id"] and i < len(base_arrivals)
                              and policy.m(base_arrivals[i]) >= policy.m(simulation_time)]
                scheduled = point.get("scheduled_arrival")
                exact = [candidate for candidate in candidates if candidate[2] == scheduled]
                if exact:
                    candidates = exact
                if candidates:
                    index, bus, base = min(candidates, key=lambda candidate: policy.m(candidate[2]))
                    if point.get("eta") and re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", str(point["eta"])):
                        target = policy.m(str(point["eta"]))
                    else:
                        target = policy.m(base) + delay
                    latest = policy.m(STATE["scenario"]["plan_window"]["end"]) - bus["dwell_min"]
                    target = min(max(target, policy.m(STATE["scenario"]["plan_window"]["start"])), latest)
                    target_time = policy.hhmm(target)
                    delay = target - policy.m(base)
                    level = "heavy" if delay >= 10 else "moderate" if delay >= 5 else "slow" if delay > 0 else "free"
                    event.update(delay_min=delay, traffic_level=level)
                    changed_schedule = bus["arrives"] != target_time
                    bus["arrives"] = target_time
                    event["trip_arrival"] = base
                    event["predicted_arrival"] = target_time
            elif event["vehicle_type"] == "freight":
                booking_id = str(point.get("booking_id") or event["vehicle_id"])
                booking = next((b for b in STATE["bookings"] if b["id"] == booking_id), None)
                if booking:
                    base = STATE["traffic_base_starts"].setdefault(booking_id, booking["start"])
                    latest = policy.m(STATE["scenario"]["plan_window"]["end"]) - booking["duration"]
                    target = min(policy.m(base) + delay, latest)
                    target_time = policy.hhmm(target)
                    changed_schedule = booking["start"] != target_time
                    booking["start"] = target_time
                    event["booking_id"] = booking_id
                    event["predicted_start"] = target_time
            STATE["traffic"][event["vehicle_id"]] = event
            plan = replan_state() if changed_schedule and STATE.get("plan") else None
            if changed_schedule:
                audit_event("traffic_replan", {"vehicleId": event["vehicle_id"], "level": level,
                                                "delayMin": delay, "scheduledTime": target_time})
            if not plan:
                save_state()
            await websocket.send_json({"type": "gps_ack", "point": event, "traffic": STATE["traffic"],
                                      "bus_trace": STATE["scenario"]["bus_trace"], "bookings": STATE["bookings"],
                                      "plan": plan, "insights": STATE["insights"] if plan else None,
                                      "replanned": bool(plan)})
    except WebSocketDisconnect:
        return

@app.post("/api/ingest/scenario")
def ingest(req: IngestReq, u=Depends(current_user)):
    errs = policy.validate_scenario(req.scenario)
    if errs:
        return {"ok": False, "errors": errs}
    if not req.dry_run:
        reset_state(req.scenario); log(u, "Loaded a new scenario.json")
    return {"ok": True, "errors": [], "loaded": not req.dry_run}

@app.post("/api/check")
def check(req: CheckReq, u=Depends(current_user)):
    sc = STATE["scenario"]
    errs = policy.validate_booking({"vendor": "x", "phone": "x", "vehicle_type": req.vehicle_type, "slot_id": req.slot_id,
                                    "start": req.start, "duration": req.duration}, sc, "check")
    if errs:
        raise HTTPException(422, "; ".join(errs))
    st = next(s for s in sc["slots"] if s["id"] == req.slot_id)["type"]
    s = policy.m(req.start)
    app_, viol = policy.evaluate(req.vehicle_type, st, s, s + req.duration, STATE["curfew_overrides"])
    if not app_:
        return {"verdict": "refer_to_inspector", "message": INSPECTOR, "rules": []}
    if viol:
        return {"verdict": "violation", "message": "Not allowed: " + " ".join(r["text"] for r in viol),
                "rules": [{"id": r["id"], "text": r["text"]} for r in viol]}
    return {"verdict": "compliant", "message": "Allowed under: " + " ".join(r["text"] for r in app_),
            "rules": [{"id": r["id"], "text": r["text"]} for r in app_]}

# ---------- editing routes ----------
@app.post("/api/bookings")
def add_booking(b: BookingIn, u=Depends(current_user)):
    nums = [int(x["id"][1:]) for x in STATE["bookings"] if re.match(r"^T[0-9]+$", x["id"])]
    nid = f"T{max(nums + [0]) + 1}"
    item = {"id": nid, **b.model_dump()}
    errs = policy.validate_booking(item, STATE["scenario"])
    if errs:
        raise HTTPException(422, "; ".join(errs))
    STATE["bookings"].append(item)
    STATE["traffic_base_starts"][nid] = item["start"]
    log(u, f"Added booking {nid} ({b.vendor} {b.start})")
    return {"id": nid}

@app.delete("/api/bookings/{bid}")
def del_booking(bid: str, u=Depends(current_user)):
    STATE["bookings"] = [x for x in STATE["bookings"] if x["id"] != bid]
    STATE["inspector_decisions"].pop(bid, None)
    STATE["traffic_base_starts"].pop(bid, None)
    STATE["traffic"].pop(bid, None)
    plan = replan_state()
    log(u, f"Removed booking {bid}")
    return {"ok": True, "plan": plan}

@app.post("/api/incidents")
def add_incident(i: IncidentIn, u=Depends(current_user)):
    errs = policy.validate_incident(i.model_dump(), STATE["scenario"])
    if errs:
        raise HTTPException(422, "; ".join(errs))
    STATE["incidents"].append(i.model_dump())
    log(u, f"Reported incident in {i.slot_id} at {i.start}: {i.reason}")
    return {"ok": True}

@app.delete("/api/incidents")
def clear_incidents(u=Depends(current_user)):
    STATE["incidents"] = []
    log(u, "Cleared incidents")
    return {"ok": True}

@app.post("/api/reset")
def reset(u=Depends(current_user)):
    reset_state(); log(u, "Reset to scenario.json")
    return {"ok": True}

# ---------- the end-to-end agent workflow ----------
def _send(o, u, event_time=None):
    gw, ok = deliver(o["phone"], o["text"])
    o.update(status="sent" if ok else "failed", gateway=gw, ts=time.strftime("%H:%M:%S"), event_time=event_time)
    log(u, f"SMS to {o['to']} {o['status']} via {gw}")
    audit_event("sms_dispatch", {"id": o["id"], "to": o["to"], "status": o["status"], "eventTime": event_time}, u["name"])

@app.post("/api/workflow/run")
def run_workflow(req: RunReq, u=Depends(current_user)):
    if not policy.verify_rulebook():
        raise HTTPException(409, "rulebook.json changed on disk. The rulebook is immutable at runtime: restore the file and restart the backend.")
    sc = STATE["scenario"]
    plan = engine.make_plan(sc, STATE["bookings"], STATE["incidents"], STATE["curfew_overrides"],
                            STATE["inspector_decisions"], STATE["dwell_history"])
    ins = engine.insights(sc, plan)
    mt = plan["metrics"]
    acts = plan["actions"]
    moved = [a for a in acts if a["status"] == "moved"]
    inspector = [a for a in acts if a["status"] == "inspector"]
    hard = [c for c in plan["clashes"] if c["severity"] == "hard"]
    for b in plan["guardrail"]["blocked_actions"]:
        guard_note("action", b["reason"], b["id"])
    for action in acts:
        audit_event("agent_decision", action, u["name"])
        for reason in action["reasons"]:
            if reason["rule"].startswith("R"):
                audit_event("rulebook_enforcement", {"bookingId": action["id"], **reason}, u["name"])

    # draft SMS: tempo re-routing messages + one bus dispatch confirmation, then AUTO-SEND
    keep = [o for o in STATE["outbox"] if o["status"] != "draft"]
    have = {o.get("key") for o in keep}
    new = []
    def add(kind, to, phone, text, src, key):
        if key in have:
            return
        draft = {"id": f"S{len(keep) + len(new) + 1}", "kind": kind, "key": key, "to": to, "phone": phone, "text": text,
                 "source": src, "status": "draft", "ts": None, "gateway": None}
        new.append(draft)
        audit_event("sms_draft", {"id": draft["id"], "kind": kind, "to": to, "text": text, "source": src}, u["name"])
    for a in moved:
        text, src = tempo_sms(sc, a, req.use_llm)
        add("tempo", a["vendor"], a["phone"], text, src, f"tempo|{a['id']}|{a['slot']}|{a['new_start']}")
    d = dispatch_sms(sc, plan, req.use_llm)
    if d:
        add("bus_dispatch", sc["bus_dispatch"]["name"], sc["bus_dispatch"]["phone"], d[0], d[1],
            "dispatch|" + ",".join(sorted(f"{r['bus']}@{r['arrives']}" for r in d[2])) + "|" + ",".join(sorted(a["id"] for a in moved)))
    STATE["outbox"] = keep + new
    for o in new:
        _send(o, u, req.current_time)
        if req.auto_reply and o["status"] == "sent":
            o["status"] = "confirmed"
    sent = [o for o in new if o["status"] in ("sent", "confirmed")]
    mt["instructions_issued"] = len([o for o in STATE["outbox"] if o["kind"] == "tempo" and o["status"] in ("sent", "confirmed")])

    # AI briefing (guard-checked)
    facts = (f"{len(moved)} of {len(acts)} bookings re-allocated; {len(inspector)} referred to the inspector; "
             f"{mt['bus_delay_minutes_lost']} min lost by buses; {mt['circling_km_avoided']} km circling avoided; "
             f"compliance {ins['compliance_before_pct']}% to {ins['compliance_after_pct']}%; peak hour {ins['peak_hour']}.")
    brief = None
    if req.use_llm:
        t = llm("Write a 2-sentence operations briefing for a campus traffic officer using only these facts:\n" + facts, 100)
        if t:
            ok, why = policy.guard_text(t)
            brief = t if ok else None
            if not ok: guard_note("briefing", why, t)
    ins["briefing"] = brief or ("Plan ready. " + facts)
    ins["briefing_source"] = MODEL if brief else "template"

    ck = plan["checks"]
    STATE["plan"], STATE["insights"] = plan, ins
    STATE["last_agent_briefing"] = ins["briefing"]
    STATE["steps"] = [
        {"name": "Ingest & validate", "status": "done", "detail": f"rulebook v{RULEBOOK['version']} verified (sha256 {RULEBOOK_HASH[:10]}); scenario valid: {len(sc['slots'])} slots, {len(sc['bus_trace'])} bus arrivals, {len(STATE['bookings'])} bookings"},
        {"name": "Enforce rulebook", "status": "done", "detail": f"{len([a for a in acts if any(r['rule'].startswith('R') for r in a['reasons'])])} request(s) breach a rule; {len(inspector)} not covered: {INSPECTOR if inspector else 'none'}"},
        {"name": "Detect clashes", "status": "done", "detail": f"{len(hard)} bus-bay clash(es) ({len([c for c in hard if c['type']=='school_bus'])} with a school bus); {len([c for c in plan['clashes'] if c['severity']=='info'])} school-exit overlap(s) noted"},
        {"name": "Re-allocate curb", "status": "done", "detail": f"{len(moved)} moved, {len(acts) - len(moved) - len(inspector)} kept; lockup-free: {'yes' if ck['lockup_free'] else 'NO'}; bus bay protected"},
        {"name": "Generate 6-hour plan", "status": "done", "detail": f"{plan['window'][0]}-{plan['window'][1]} across {len(sc['slots'])} slots ({ck['curb_length_used_m']:g} of {ck['curb_length_m']:g} m)"},
        {"name": "Draft & send SMS", "status": "done", "detail": f"{len(new)} drafted ({len([o for o in new if o['kind']=='tempo'])} tempo, {len([o for o in new if o['kind']=='bus_dispatch'])} bus dispatch), {len(sent)} sent automatically" + (", replies simulated" if req.auto_reply else "")},
        {"name": "Score", "status": "done", "detail": f"buses lost {mt['bus_delay_minutes_lost']} min ({'zero-delay validated' if mt['zero_delay_validated'] else 'not zero'}); {mt['circling_km_avoided']} km circling avoided"},
    ]
    log(u, f"Ran workflow: {len(moved)} moved, {len(inspector)} to inspector, {len(sent)} SMS auto-sent")
    save_state()
    return {"plan": plan, "steps": STATE["steps"], "outbox": STATE["outbox"], "insights": ins,
            "last_agent_briefing": STATE["last_agent_briefing"], "guard_log": STATE["guard_log"]}

def _msg(mid):
    for o in STATE["outbox"]:
        if o["id"] == mid:
            return o
    raise HTTPException(404, "Message not found")

@app.post("/api/outbox/{mid}/send")
def send_one(mid: str, req: SendIn = SendIn(), u=Depends(current_user)):
    _send(_msg(mid), u, req.current_time)
    return {"outbox": STATE["outbox"]}

@app.post("/api/outbox/{mid}/reply")
def simulate_reply(mid: str, req: ReplyIn = ReplyIn(), u=Depends(current_user)):
    o = _msg(mid)
    if o["status"] != "sent":
        raise HTTPException(409, "Send the message first")
    reply = req.message.strip()
    late = re.search(r"(?:arriv\w*|late|delay\w*)[^0-9]{0,24}(\d{1,2})\s*(?:min(?:ute)?s?)|(?<!\d)(\d{1,2})\s*min(?:ute)?s?\s*late", reply, re.I)
    moved_booking = None
    if late:
        minutes = int(late.group(1) or late.group(2))
        parts = (o.get("key") or "").split("|")
        booking = next((b for b in STATE["bookings"] if len(parts) > 1 and b["id"] == parts[1]), None)
        if booking:
            updated_start = policy.hhmm(policy.m(booking["start"]) + minutes)
            candidate = {**booking, "start": updated_start}
            if not policy.validate_booking(candidate, STATE["scenario"]):
                booking["start"] = updated_start
                STATE["traffic_base_starts"][booking["id"]] = updated_start
                moved_booking = {"id": booking["id"], "start": updated_start, "late_min": minutes}
                replan_state()
    o.update(status="confirmed", reply=reply, reply_ts=time.strftime("%H:%M:%S"), reallocation=moved_booking)
    log(u, f"{o['to']} replied: {reply[:100]}" + (f"; reallocated to {moved_booking['start']}" if moved_booking else ""))
    audit_event("sms_reply", {"id": mid, "message": reply, "reallocation": moved_booking}, u["name"])
    save_state()
    return {"outbox": STATE["outbox"], "reallocation": moved_booking}

@app.post("/api/ask")
def ask(req: AskReq, u=Depends(current_user)):
    rules = "\n".join(f"{r['id']}: {r['text']}" for r in RULEBOOK["rules"])
    out = llm(f"You are a curb-rules assistant. Use ONLY these rules:\n{rules}\n\nQuestion: {req.question}\n"
              f"If a rule clearly answers it, reply as '<RULE_ID>: <short answer>'. If no rule covers it, reply exactly: NONE", 60) or "NONE"
    ok, why = policy.guard_text(out)
    if not ok:
        guard_note("ask", why, out); out = "NONE"
    for r in RULEBOOK["rules"]:
        if out.startswith(r["id"]):
            return {"answer": out, "rule": r["id"]}
    return {"answer": INSPECTOR, "rule": None}