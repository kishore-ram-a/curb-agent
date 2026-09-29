"""Clash detection, priority allocation and the 6-hour curb plan generator."""
import re
import policy
from policy import m, hhmm, evaluate, guard_action, overlap, INSPECTOR

STEP = 5                 # minutes, allocation resolution
CELL = 15                # minutes per cell in the occupancy grid
REROUTE_PENALTY = 2      # minutes a bus still loses if it must use a temporary halt
CIRCLE_KMH = 12          # assumed crawling speed of a vehicle circling the gate
CIRCLE_CAP_MIN = 20      # assumed max circling time without instructions


def meters(sc):
    out, x = {}, 0.0
    for s in sc["slots"]:
        out[s["id"]] = (round(x, 1), round(x + s["length_m"], 1))
        x += s["length_m"]
    return out


def _load(placed, slot_id, t):
    return sum(p["w"] for p in placed if p["slot"] == slot_id and p["s"] <= t < p["s"] + p["dur"])


def has_room(placed, slot, s, d):
    pts = list(range(s, s + d, STEP)) + [s + d - 1]
    return all(_load(placed, slot["id"], t) + 1 <= slot["capacity"] for t in pts)


def make_plan(sc, bookings, incidents=None, curfew_overrides=None, inspector_decisions=None, dwell_history=None):
    curfew_overrides = curfew_overrides or {}
    inspector_decisions = inspector_decisions or {}
    dwell_history = dwell_history or {}
    rules = [dict(r) for r in policy.RULES]
    for rule in rules:
        if rule["type"] == "freight_window" and "freight_window" in curfew_overrides:
            rule.update(curfew_overrides["freight_window"])
            rule["text"] = f"Operational freight window is {rule['start']}-{rule['end']} (R2)."

    def evaluate(vehicle_type, slot_type, start, end):
        return policy.evaluate(vehicle_type, slot_type, start, end, curfew_overrides)
    incidents = incidents or []
    slots = sc["slots"]
    smap = {s["id"]: s for s in slots}
    met = meters(sc)
    w0, w1 = m(sc["plan_window"]["start"]), m(sc["plan_window"]["end"])
    bay_slots = [s for s in slots if s["type"] == "bus_bay"]
    gen_slots = [s for s in slots if s["type"] != "bus_bay"]
    exits = sc["school_exit"]
    routes = sc.get("routes", {})

    def lane(slot_id):
        return routes.get(slot_id) or smap[slot_id]["label"]

    def gate(slot_id):
        value = smap[slot_id].get("gate") or routes.get(slot_id, "")
        found = re.search(r"Gate\s*(\d+)", value, re.I)
        return f"Gate {found.group(1)}" if found else "Gate 2"

    placed, actions, bus_rows, clashes, blocked = [], [], [], [], []

    # 1) live incidents fully occupy their slot
    for i, inc in enumerate(incidents):
        sl = smap.get(inc["slot_id"])
        if sl:
            placed.append({"id": f"INC{i+1}", "slot": sl["id"], "s": m(inc["start"]), "dur": inc["duration"],
                           "w": sl["capacity"], "label": inc.get("reason") or "Incident", "kind": "incident"})

    # 2) buses have priority: the bus bay is allocated to them first (R3)
    for bus in sorted(sc["bus_trace"], key=lambda b: m(b["arrives"])):
        a0, base_dwell = m(bus["arrives"]), bus["dwell_min"]
        history = dwell_history.get(bus["id"], [])
        average_dwell = sum(history) / len(history) if history else base_dwell
        d = max(base_dwell, round(average_dwell + 0.5)) + (2 if average_dwell > 5 else 0)
        a1, dl = a0 + d, bus["delay_if_blocked_min"]
        school = any(overlap(a0, a1, m(x["start"]), m(x["end"])) for x in exits)
        threats = [f"{b['vendor']}" for b in bookings if smap[b["slot_id"]]["type"] == "bus_bay"
                   and overlap(m(b["start"]), m(b["start"]) + b["duration"], a0, a1)]
        threats += [inc.get("reason") or "Incident" for inc in incidents if smap.get(inc["slot_id"], {}).get("type") == "bus_bay"
                    and overlap(m(inc["start"]), m(inc["start"]) + inc["duration"], a0, a1)]
        row = {"bus": bus["id"], "arrives": bus["arrives"], "destination": bus["destination"], "dwell": d, "base_dwell": base_dwell, "predicted_dwell": d, "historical_average_dwell": round(average_dwell, 1), "school_bus": school, "slot": None, "bay": "kept clear", "blocked_by": threats[0] if threats else None, "reroute": None, "delay_without": dl if threats else 0, "delay_with": 0}
        pl = {"id": f"BUS-{bus['id']}-{bus['arrives']}", "s": a0, "dur": d, "w": 1, "label": bus["id"], "kind": "bus"}
        home = next((s for s in bay_slots if has_room(placed, s, a0, d)), None)
        if home:
            placed.append({**pl, "slot": home["id"]}); row["slot"] = home["id"]
        else:
            alt_slots = sorted(gen_slots, key=lambda s: (gate(s["id"]) == gate(bay_slots[0]["id"]), s["id"]))
            alt = next((s for s in alt_slots if has_room(placed, s, a0, d)), None)
            if alt:
                placed.append({**pl, "slot": alt["id"]}); row.update(slot=alt["id"], bay="rerouted", delay_with=REROUTE_PENALTY,
                    reroute=f"{bus['id']} halts at {alt['label']} ({lane(alt['id'])}) for {d} min: {INSPECTOR}")
            else:
                row.update(bay="inspector", reroute=INSPECTOR, delay_with=dl)
        bus_rows.append(row)

    # 3) live school-exit / bus-bay clash detector (on the requests as booked)
    for b in bookings:
        s, e, sl = m(b["start"]), m(b["start"]) + b["duration"], smap[b["slot_id"]]
        if sl["type"] == "bus_bay":
            for r in bus_rows:
                a0 = m(r["arrives"]); a1 = a0 + r["dwell"]
                if overlap(s, e, a0, a1):
                    kind = "school_bus" if r["school_bus"] else "bus_bay"
                    clashes.append({"type": kind, "severity": "hard", "at": hhmm(max(s, a0)), "booking": b["id"], "vendor": b["vendor"], "bus": r["bus"],
                                    "overlap_min": min(e, a1) - max(s, a0),
                                    "text": f"{b['vendor']} ({b['start']}-{hhmm(e)}) clashes with {'school bus ' if r['school_bus'] else 'bus '}{r['bus']} "
                                            f"({r['arrives']}-{hhmm(a1)}) in the {sl['label'].lower()}"})
        elif b["vehicle_type"] == "freight":
            for x in exits:
                if overlap(s, e, m(x["start"]), m(x["end"])):
                    clashes.append({"type": "school_exit", "severity": "info", "at": hhmm(max(s, m(x["start"]))), "booking": b["id"], "vendor": b["vendor"], "bus": None, "overlap_min": 0,
                                    "text": f"{b['vendor']} overlaps the school-exit interval {x['start']}-{x['end']} (information only, no rule broken)"})

    def base(b, **kw):
        a = {"id": b["id"], "vendor": b["vendor"], "phone": b["phone"], "vehicle_type": b["vehicle_type"],
             "old_slot": b["slot_id"], "old_start": b["start"], "duration": b["duration"], "shift_min": 0,
             "circling_km_avoided": 0.0, "reroute": None, "reasons": []}
        a.update(kw)
        return a

    def occupy(b, slot_id, st):
        placed.append({"id": b["id"], "slot": slot_id, "s": st, "dur": b["duration"], "w": 1, "label": b["vendor"], "kind": "booking"})

    # 4) requests that are already governed, compliant and free stay put
    bad = []
    for b in sorted(bookings, key=lambda x: (m(x["start"]), x["id"])):
        s, d, sl = m(b["start"]), b["duration"], smap[b["slot_id"]]
        app, viol = evaluate(b["vehicle_type"], sl["type"], s, s + d)
        room = has_room(placed, sl, s, d)
        if app and not viol and room:
            occupy(b, sl["id"], s)
            actions.append(base(b, action="keep", status="kept", slot=sl["id"], new_start=b["start"]))
        else:
            bad.append((b, app, viol, room))

    # 5) re-allocation: out of the bus bay to a general slot, else delayed to an allowed window
    for b, app, viol, room in bad:
        s, d = m(b["start"]), b["duration"]
        if not app:   # the rulebook is silent about this vehicle/slot/time
            decision = inspector_decisions.get(b["id"])
            if decision and decision.get("decision") == "approved":
                target = smap.get(decision.get("slot_id", b["slot_id"]))
                start = m(decision.get("start", b["start"])) if target else s
                if target and w0 <= start and start + d <= w1 and has_room(placed, target, start, d):
                    occupy(b, target["id"], start)
                    actions.append(base(b, action="keep", status="approved", slot=target["id"], new_start=hhmm(start),
                                        reasons=[{"rule": "none", "text": "Manually approved by the inspector."}]))
                else:
                    actions.append(base(b, action="refer_to_inspector", status="inspector", slot=b["slot_id"], new_start=None,
                                        reasons=[{"rule": "none", "text": "Inspector approval could not fit the requested capacity or plan window."}]))
            elif decision and decision.get("decision") == "rejected":
                actions.append(base(b, action="refer_to_inspector", status="rejected", slot=b["slot_id"], new_start=None,
                                    reasons=[{"rule": "none", "text": "Manually rejected by the inspector."}]))
            else:
                actions.append(base(b, action="refer_to_inspector", status="inspector", slot=b["slot_id"], new_start=None,
                                    reasons=[{"rule": "none", "text": INSPECTOR}]))
            continue
        reasons = [{"rule": r["id"], "text": r["text"]} for r in viol]
        hard = [c for c in clashes if c["booking"] == b["id"] and c["severity"] == "hard"]
        reasons += [{"rule": "data", "text": c["text"]} for c in hard]
        if not viol and not room:
            reasons.append({"rule": "data", "text": "Requested slot is at capacity or blocked by an incident."})
        found = None
        order = sorted(gen_slots, key=lambda x: (gate(x["id"]) == gate(b["slot_id"]), x["id"]))
        for delta in range(0, w1 - w0 + 1, STEP):
            for sign in ((1, -1) if delta else (1,)):
                st = s + sign * delta
                if st < w0 or st + d > w1:
                    continue
                for cs in order:
                    ap2, v2 = evaluate(b["vehicle_type"], cs["type"], st, st + d)
                    if ap2 and not v2 and has_room(placed, cs, st, d):
                        found = (st, cs); break
                if found: break
            if found: break
        if not found:
            actions.append(base(b, action="refer_to_inspector", status="inspector", slot=b["slot_id"], new_start=None,
                                reasons=reasons + [{"rule": "none", "text": INSPECTOR}]))
            continue
        st, cs = found
        shift, changed = st - s, cs["id"] != b["slot_id"]
        kind = "reallocate_and_delay" if changed and shift else "reallocate" if changed else "delay"
        overlap_min = sum(c["overlap_min"] for c in hard)
        km = round(min(CIRCLE_CAP_MIN, abs(shift) + overlap_min) / 60 * CIRCLE_KMH, 1)
        rr = (f"Reroute {b['vendor']}: {lane(b['slot_id'])} → {lane(cs['id'])}" if changed
              else f"Same lane ({lane(cs['id'])}), new time")
        occupy(b, cs["id"], st)
        actions.append(base(b, action=kind, status="moved", slot=cs["id"], new_start=hhmm(st), shift_min=shift,
                            circling_km_avoided=km, reroute=rr, reasons=reasons))

    # 6) guardrail pass: nothing leaves the engine unless it cites real rules and permitted actions
    for i, a in enumerate(actions):
        ok, why = guard_action(a)
        if not ok:
            blocked.append({"id": a["id"], "reason": why})
            actions[i] = {**a, "action": "refer_to_inspector", "status": "inspector", "slot": a["old_slot"], "new_start": None,
                          "reroute": None, "circling_km_avoided": 0.0, "reasons": [{"rule": "none", "text": INSPECTOR}]}
    actions.sort(key=lambda a: (m(a["old_start"]), a["id"]))
    moved_ids = {a["id"] for a in actions if a["status"] == "moved"}

    # 7) checks: no lockup, every bus served, curb boundary respected
    lock = [f"{s['id']} at {hhmm(t)}" for s in slots for t in range(w0, w1, STEP) if _load(placed, s["id"], t) > s["capacity"]]
    checks = {"lockup_free": not lock, "lockup_details": lock,
              "all_buses_served": all(r["bay"] != "inspector" for r in bus_rows),
              "curb_length_used_m": round(sum(s["length_m"] for s in slots), 1), "curb_length_m": sc["curb_length_m"],
              "curb_boundary_ok": sum(s["length_m"] for s in slots) <= sc["curb_length_m"] + 1e-9}

    # 8) occupancy grid + curfew state
    status_by_id = {a["id"]: a["status"] for a in actions}
    times = list(range(w0, w1, CELL))
    grid = []
    for sl in slots:
        cells = []
        for t in times:
            occ = [p for p in placed if p["slot"] == sl["id"] and overlap(p["s"], p["s"] + p["dur"], t, t + CELL)]
            if not occ:
                cells.append({"t": hhmm(t), "k": "free", "label": ""}); continue
            p = sorted(occ, key=lambda x: {"incident": 0, "bus": 1, "booking": 2}[x["kind"]])[0]
            k = p["kind"] if p["kind"] != "booking" else status_by_id.get(p["id"], "kept")
            cells.append({"t": hhmm(t), "k": k, "label": p["label"]})
        grid.append({"slot": sl["id"], "label": sl["label"], "type": sl["type"], "gate": gate(sl["id"]), "from_m": met[sl["id"]][0], "to_m": met[sl["id"]][1],
                     "capacity": sl["capacity"], "cells": cells})
    curfews = []
    for r in rules:
        if r["type"] == "no_standing":
            curfews.append({"type": "no_standing", "rule": r["id"], "start": r["start"], "end": r["end"], "text": r["text"]})
        elif r["type"] == "freight_window":
            curfews.append({"type": "freight_window", "rule": r["id"], "start": r["start"], "end": r["end"], "text": r["text"],
                            "operational_override": "freight_window" in curfew_overrides})
    for x in exits:
        curfews.append({"type": "school_exit", "rule": "data", "start": x["start"], "end": x["end"],
                        "text": f"Reserved school-exit interval {x['start']}-{x['end']}"})
    states = []
    for t in times:
        st = [c["type"] for c in curfews if overlap(t, t + CELL, m(c["start"]), m(c["end"]))]
        states.append({"t": hhmm(t), "states": st})

    lost = sum(r["delay_with"] for r in bus_rows)
    saved = sum(r["delay_without"] - r["delay_with"] for r in bus_rows)
    km = round(sum(a["circling_km_avoided"] for a in actions), 1)
    return {
        "campus": sc["campus"], "window": [sc["plan_window"]["start"], sc["plan_window"]["end"]],
        "actions": actions, "buses": bus_rows, "clashes": clashes, "curfews": curfews, "curfew_states": states,
        "grid": grid, "checks": checks, "guardrail": {"blocked_actions": blocked},
        "placed": [{**p, "start": hhmm(p["s"]), "end": hhmm(p["s"] + p["dur"])} for p in placed],
        "metrics": {"bus_delay_saved_min": saved, "bus_delay_minutes_lost": lost,
                    "zero_delay_validated": lost == 0 and all(r["bay"] != "inspector" for r in bus_rows),
                    "circling_km_avoided": km, "displaced_vendors": len(moved_ids), "instructions_issued": 0,
                    "assumption": f"Without instructions a displaced vehicle circles up to {CIRCLE_CAP_MIN} min at {CIRCLE_KMH} km/h "
                                  f"(mock estimate); a bus on a temporary halt still loses {REROUTE_PENALTY} min."},
    }


def insights(sc, plan):
    acts = plan["actions"]
    total = len(acts) or 1
    kept = sum(a["status"] == "kept" for a in acts)
    moved = [a for a in acts if a["status"] == "moved"]
    stuck = [a for a in acts if a["status"] == "inspector"]
    w0, w1 = m(sc["plan_window"]["start"]), m(sc["plan_window"]["end"])
    span = w1 - w0
    util = {}
    for s in sc["slots"]:
        used = sum(p["dur"] for p in plan["placed"] if p["slot"] == s["id"])
        util[s["id"]] = {"label": s["label"], "pct": round(min(used, span * s["capacity"]) / (span * s["capacity"]) * 100)}
    hours = {t: sum(max(0, min(p["s"] + p["dur"], t + 60) - max(p["s"], t)) for p in plan["placed"]) for t in range(w0, w1, 60)}
    peak = max(hours, key=hours.get)
    cnt = lambda rid: sum(any(r["rule"] == rid for r in a["reasons"]) for a in acts)
    recs = []
    if cnt("R2"): recs.append(f"{cnt('R2')} freight request(s) fell outside the 11:00-13:00 freight window (R2). Show the window in the booking form.")
    if cnt("R3"): recs.append(f"{cnt('R3')} vehicle(s) requested the reserved bus bay (R3). Hide bus-bay slots from non-bus bookings.")
    if cnt("R1"): recs.append(f"{cnt('R1')} request(s) fell inside the no-standing hour (R1). Block 07:30-08:30 in the booking form.")
    hard = [c for c in plan["clashes"] if c["severity"] == "hard"]
    if hard: recs.append(f"{len(hard)} clash(es) with buses were resolved by moving vehicles out of the bus bay.")
    if any(r["bay"] == "rerouted" for r in plan["buses"]): recs.append("A bus needed a temporary halt outside the bay. Keep one general slot free around bus arrivals.")
    if stuck: recs.append(f"{len(stuck)} request(s) are not covered by the rulebook: {INSPECTOR}")
    if not recs: recs.append("All bookings are already compliant. No action needed.")
    return {
        "compliance_before_pct": round(kept / total * 100),
        "compliance_after_pct": round((kept + len(moved)) / total * 100),
        "vendor_minutes_shifted": sum(abs(a["shift_min"]) for a in moved),
        "utilisation": util, "peak_hour": f"{hhmm(peak)}-{hhmm(peak + 60)}", "peak_minutes": hours[peak],
        "buses_threatened": sum(1 for r in plan["buses"] if r["blocked_by"]),
        "buses_protected": sum(1 for r in plan["buses"] if r["bay"] in ("kept clear", "rerouted")),
        "referred_to_inspector": len(stuck), "recommendations": recs,
    }