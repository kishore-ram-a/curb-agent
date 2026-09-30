# 🚌 Curb Agent: Bus-Priority & Curb-Window Agent

An agentic web app that helps a city officer keep the **bus bay free for buses** by automatically rescheduling delivery vehicles, rerouting around incidents, and drafting SMS notices for approval.

Built for the *Sustainable Agentic AI* hackathon brief (project #26).

**Live demo:** `https://<your-vercel-domain>.vercel.app`
**API docs:** `https://curb-agent-api.onrender.com/docs`

> The backend runs on Render's free tier and sleeps when idle. The first request can take up to a minute.

**Demo login:** `admin` / `curb@2026`

---

## The problem

Delivery trucks park in the bus bay at the wrong time and delay buses. Fixing this today means manual phone calls and guesswork.

## How it works

The agent runs an end-to-end workflow:

**Ingest → Check rulebook → Replan → Reroute → Draft SMS → Officer approval → Score**

**Example:** tempo `T1` is booked for the bus bay at 12:00, but bus `B21` arrives then.

1. The agent checks the rulebook and detects the conflict.
2. It moves `T1` to 13:00 and keeps the bay free for the bus.
3. It drafts an SMS to the vendor explaining the change.
4. The officer edits and approves it, and the vendor replies "OK".
5. If an incident blocks the bus bay, the bus is rerouted to a temporary halt at the delivery bay.

## Features

- **Six-hour timeline:** curfews, school exit, buses, original vs. new slots
- **Rerouting:** moved tempos get a new lane or route; incidents reroute buses
- **SMS outbox:** editable drafts, approve and send, simulated vendor replies (draft → sent → confirmed)
- **Live operations:** GPS and traffic updates over WebSocket trigger instant replanning
- **Inspector tab:** approve or reject requests the rulebook doesn't cover
- **Ask the rulebook:** unknown questions get "Refer to the inspector." instead of a guess
- **Audit log:** decision history, plus optional daily CSV reports via PostgreSQL

## Tech stack

| Layer | Technology | Hosted on |
|---|---|---|
| Frontend | React, Vite, Tailwind CSS | Vercel |
| Backend | FastAPI (Python), WebSockets | Render |
| AI | Llama 3.2 3B via Ollama (template fallback if unavailable) | Local |
| Audit (optional) | Node.js, Prisma, PostgreSQL | Separate host |

## Project structure

```
curb-agent-v2/
├── backend/          # FastAPI app: main.py, engine.py, policy.py, agent.py, data/
├── frontend/         # React + Vite UI
├── audit-service/    # Optional Prisma + PostgreSQL audit service
├── render.yaml       # Render blueprint for the backend
└── README.md
```

## Run locally

1. **Ollama** (optional, for AI-written SMS): `ollama pull llama3.2:3b`
2. **Backend:**
   ```bash
   cd backend
   pip install -r requirements.txt
   uvicorn main:app --port 8000
   ```
3. **Frontend:**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
   Open http://localhost:5173 (the dev server proxies `/api` to port 8000).

If Ollama isn't running, the app automatically falls back to template-based SMS drafts.

## Deployment

The frontend and backend deploy separately because the backend keeps sessions in memory and serves WebSockets, which Vercel Functions don't support.

### Backend on Render
1. Push the repo to GitHub.
2. In Render, choose **New → Blueprint**, select the repo, and apply `render.yaml`.
3. Copy the service URL, e.g. `https://curb-agent-api.onrender.com`.

### Frontend on Vercel
1. Import the repo into Vercel and set the **Root Directory to `frontend`**.
2. Add these environment variables as **plain text (Config)**, not Secret, for Production and Preview:

   | Key | Value |
   |---|---|
   | `VITE_API_BASE_URL` | `https://curb-agent-api.onrender.com` |
   | `VITE_WS_BASE_URL` | `wss://curb-agent-api.onrender.com` |

   Use origins only, with no trailing slash and no `/api`. The API URL must use `https://`; only the WebSocket URL uses `wss://`.
3. Redeploy after any variable change, because Vite bakes them in at build time.
4. To make the site public, set **Settings → Deployment Protection → Vercel Authentication** to *Disabled*.

## Optional integrations

**Real SMS (Twilio):** set these on the backend, otherwise a mock gateway is used.
```bash
export TWILIO_SID=... TWILIO_TOKEN=... TWILIO_FROM=+1...
```

**PostgreSQL audit service:**
1. Create a database named `curb_audit`.
2. In `audit-service`, copy `.env.example` to `.env` and set `DATABASE_URL`.
3. Run `npm install`, `npm run db:generate`, `npm run db:push`, then `npm start`.
4. Point the backend at it with `PRISMA_AUDIT_URL` and `PRISMA_AUDIT_REPORT_URL`.

Never put database credentials or API keys in `VITE_*` variables; they are visible in the browser.

## Demo script

1. Log in and click **Run agent**: T1 moves from 12:00 to 13:00, the bus bay is kept for B21, and two SMS drafts appear.
2. **Bookings** tab → report an incident (bus bay, 09:38, 15 min) → **Run agent**: B7 is rerouted to the delivery bay.
3. **SMS outbox** → approve and send all → simulate a reply.
4. **Rulebook** tab → ask something unregistered → "Refer to the inspector."

## Known limitations

- Ollama isn't available on the hosted backend, so SMS drafts use templates there.
- State resets when the free Render instance restarts.
- The single demo account is public and CORS is open (`*`); tighten both before real use.
- Sessions are held in memory, so a restart logs everyone out.

## Author

Built by Ram ([@kishore-ram-a](https://github.com/kishore-ram-a)) for the SRM hackathon.
