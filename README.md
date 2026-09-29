# Bus-priority & curb-window agent (v2)

## Run

1. Ollama (already a service on Fedora): `ollama pull llama3.2:3b`
2. Backend: `cd backend && pip install -r requirements.txt && uvicorn main:app --port 8000`
3. Frontend: `cd frontend && npm install && npm run dev` -> http://localhost:5173

## Deploy the UI on Vercel

Vercel can host the Vite frontend, but this app's API should run on a separate persistent host that supports WebSockets. The backend keeps sessions and current plan state in process memory and uses a writable state file; Vercel Functions do not provide a durable shared process or a WebSocket server for this workflow.

1. In Render, create a Blueprint from this repository. `render.yaml` creates the FastAPI web service, a persistent disk mounted at `/var/data`, and `CURB_STATE_FILE=/var/data/state.json`. The API is configured as one paid instance because session tokens are held in memory and Render disks cannot be shared across instances.
2. After the Render service deploys, copy its HTTPS origin, such as `https://curb-agent-api.onrender.com`.
3. Import this repository into Vercel with the repository root as the project root. `vercel.json` builds `frontend/` and serves it as a single-page app.
4. In Vercel Project Settings -> Environment Variables, set `VITE_API_BASE_URL` to the Render HTTPS origin and `VITE_WS_BASE_URL` to its WebSocket origin (replace `https://` with `wss://`). Use origins only, without a trailing slash or `/api` path, then redeploy.

The traffic feed, inspector decisions, and plan recalculation use that external API. If the optional Prisma audit service is enabled, deploy it separately and point `PRISMA_AUDIT_URL` and `PRISMA_AUDIT_REPORT_URL` from the backend to its public HTTPS endpoints. Do not put database credentials in `VITE_*` variables; those are included in browser code.

## Login (demo)

- officer / curb@2026 (run agent, edit bookings, report incidents, send SMS)
- viewer / view@2026 (read-only)

## Features

- End-to-end workflow: Ingest -> Check rulebook -> Replan -> Reroute -> Draft SMS (llama3.2:3b) -> Officer approval -> Score
- Rerouting: moved tempos get a new lane/route; a live incident in the bus bay reroutes the bus to a temporary halt at the delivery bay
- SMS outbox: edit drafts, approve & send, simulate vendor reply "OK" (draft -> sent -> confirmed)
- Visual six-hour timeline (curfews, school exit, buses, original vs new slots)
- Add/remove bookings, report incidents, audit log, "Ask the rulebook" (unknown -> "Refer to the inspector.")

## Real SMS (optional)

Set env vars before starting the backend, otherwise a mock gateway is used:
`export TWILIO_SID=... TWILIO_TOKEN=... TWILIO_FROM=+1...` (mock phone numbers must be replaced with real ones)

## PostgreSQL audit service (optional)

The demo continues to save working state and its short audit log locally. To persist decisions, rulebook enforcements, and SMS events with Prisma:

1. Start PostgreSQL and create a database named `curb_audit`.
2. In `audit-service`, copy `.env.example` to `.env` and set `DATABASE_URL` for that database.
3. Run `npm install`, `npm run db:generate`, `npm run db:push`, then `npm start`.
4. Start the backend normally. It forwards audit events to `http://127.0.0.1:8100`; the Audit log tab can generate and download daily CSV reports.

The audit service binds to loopback by default. Configure `AUDIT_HOST` only when you intentionally need remote access.

## Live operations

- The frontend sends mock GPS points over `/api/ws/live`; bus/tempo location updates are accepted continuously.
- GPS frames may include `speed_kmh`, `delay_min`, `traffic_level`, `scheduled_arrival` or `booking_id`, and `simulation_time`; changed bus/tempo times immediately replan the active six-hour schedule.
- Use the Inspector tab to approve or reject rulebook-unknown requests. Clicking a free 15-minute grid cell chooses an approval slot.
- The 6-hour plan tab can override the freight window and record observed dwell times; both changes recalculate the plan immediately.
- SMS replies accept natural language. A late reply shifts its linked booking and recalculates the plan.

## Demo script

1. Login as officer -> Run agent: T1 moved 12:00->13:00, bus bay kept for B21, two SMS drafts.
2. Bookings tab -> Report incident (bus bay, 09:38, 15 min) -> Run agent: B7 rerouted to delivery bay.
3. SMS outbox -> Approve & send all -> simulate reply.
4. Rulebook tab -> ask something unregistered -> "Refer to the inspector."
