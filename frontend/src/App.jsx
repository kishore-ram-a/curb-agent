import { Fragment, useEffect, useRef, useState } from 'react'
import { api, setToken, hasToken, websocketUrl } from './api.js'

const INSPECTOR = 'refer to the inspector.'
const toMin = (t) => {
  const [h, m] = t.split(':')
  return +h * 60 + +m
}
const hhmm = (x) =>
  `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`
const winOf = (d) => {
  const a = toMin(d.plan_window.start),
    b = toMin(d.plan_window.end)
  return {
    a,
    b,
    pct: (x) => ((Math.min(Math.max(x, a), b) - a) / (b - a)) * 100,
  }
}

function downloadCsv(name, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const a = document.createElement('a')
  a.href = URL.createObjectURL(
    new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], {
      type: 'text/csv',
    }),
  )
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

const SCENARIOS = [
  {
    label: 'Bus bay breakdown (09:38, 15 min)',
    kind: 'incident',
    body: {
      slot_id: 'BB1',
      start: '09:38',
      duration: 15,
      reason: 'Car broke down in bus bay',
    },
  },
  {
    label: 'Rush tempo books the bus bay with bus B12',
    kind: 'booking',
    body: {
      vendor: 'Rush Courier',
      vehicle_type: 'freight',
      slot_id: 'BB1',
      start: '11:20',
      duration: 20,
    },
  },
  {
    label: 'Dairy tempo outside the freight window (09:15)',
    kind: 'booking',
    body: {
      vendor: 'Amman Dairy',
      vehicle_type: 'freight',
      slot_id: 'G2',
      start: '09:15',
      duration: 30,
    },
  },
  {
    label: 'Dawn delivery in the no-standing hour',
    kind: 'booking',
    body: {
      vendor: 'Early Bakery',
      vehicle_type: 'freight',
      slot_id: 'G1',
      start: '07:55',
      duration: 20,
    },
  },
  {
    label: 'Parent car on a general slot (rulebook silent)',
    kind: 'booking',
    body: {
      vendor: 'Parent (Mr. Ravi)',
      vehicle_type: 'personal',
      slot_id: 'G2',
      start: '09:00',
      duration: 15,
    },
  },
]

/* ---------------- Pictures (inline SVG, no external images) ---------------- */
const hue = (s) => ([...s].reduce((a, c) => a + c.charCodeAt(0), 0) * 37) % 360
function Pic({ kind = 'booking', label = '', size = 26 }) {
  const vehicle =
    kind === 'bus'
      ? 'bus'
      : kind === 'incident'
        ? 'incident'
        : /parent|personal|car/i.test(label)
          ? 'car'
          : 'tempo'
  const color =
    vehicle === 'bus'
      ? '#1b6a67'
      : vehicle === 'incident'
        ? '#bd3d32'
        : vehicle === 'car'
          ? '#2866a0'
          : `hsl(${hue(label)} 48% 38%)`
  return (
    <svg
      className='pic'
      width={size}
      height={size}
      viewBox='0 0 32 32'
      role='img'
      aria-label={label}
    >
      {vehicle === 'incident' ? (
        <g>
          <path d='M16 3L31 29H1Z' fill={color} />
          <path d='M16 10v9' stroke='#fff' strokeWidth='2.5' />
          <circle cx='16' cy='23' r='1.4' fill='#fff' />
        </g>
      ) : vehicle === 'bus' ? (
        <g>
          <path d='M4 9a4 4 0 0 1 4-4h16a4 4 0 0 1 4 4v14H4z' fill={color} />
          <path d='M7 9h18v7H7z' fill='#d8efed' />
          <path d='M7 18h18v3H7z' fill='#fff' />
          <circle cx='9' cy='24' r='2.2' fill='#222' />
          <circle cx='23' cy='24' r='2.2' fill='#222' />
        </g>
      ) : vehicle === 'car' ? (
        <g>
          <path d='M4 18l2-5 4-4h11l4 4 3 2 1 6H3z' fill={color} />
          <path d='M11 11h9l3 4H8z' fill='#d8e8f5' />
          <circle cx='9' cy='21' r='2.3' fill='#222' />
          <circle cx='23' cy='21' r='2.3' fill='#222' />
        </g>
      ) : (
        <g>
          <path d='M3 11h15v11H3z' fill={color} />
          <path d='M18 14h6l4 4v4H18z' fill={color} />
          <path d='M5 13h11v5H5z' fill='#e5eeee' />
          <path d='M20 15h3l3 3h-6z' fill='#e5eeee' />
          <circle cx='9' cy='23' r='2.2' fill='#222' />
          <circle cx='23' cy='23' r='2.2' fill='#222' />
        </g>
      )}
    </svg>
  )
}

/* ---------------- AI insights + bus delay bars ---------------- */
function Insights({ ins }) {
  return (
    <div className='ins'>
      <h3>
        AI briefing <small>({ins.briefing_source})</small>
      </h3>
      <p className='brief'>{ins.briefing}</p>
      <div className='tiles'>
        <div>
          <big>
            {ins.compliance_before_pct}% → {ins.compliance_after_pct}%
          </big>
          rule compliance
        </div>
        <div>
          <big>{ins.vendor_minutes_shifted} min</big>vendor time shifted
        </div>
        <div>
          <big>{ins.buses_protected}</big>buses protected (
          {ins.buses_threatened} were threatened)
        </div>
        <div>
          <big>{ins.referred_to_inspector}</big>referred to the inspector
        </div>
        <div>
          <big>{ins.peak_hour}</big>peak curb hour ({ins.peak_minutes} min)
        </div>
      </div>
      <h3>Slot utilisation</h3>
      {Object.entries(ins.utilisation).map(([k, u]) => (
        <div key={k} className='ubar'>
          <span>{u.label}</span>
          <div>
            <i style={{ width: u.pct + '%' }} />
          </div>
          <b>{u.pct}%</b>
        </div>
      ))}
      <h3>Recommendations</h3>
      <ul className='recs'>
        {ins.recommendations.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </div>
  )
}

function DelayBars({ buses }) {
  const risky = buses.filter((b) => b.delay_without > 0)
  if (!risky.length)
    return <p className='sub'>No bus was at risk in this plan.</p>
  const max = Math.max(10, ...risky.map((b) => b.delay_without))
  return risky.map((b, i) => (
    <div key={i} className='dbar'>
      <span className='dpic'>
        <Pic kind='bus' label={b.bus} size={18} />
        {b.bus} {b.arrives}
      </span>
      <div>
        <i
          className='bad'
          style={{ width: (b.delay_without / max) * 100 + '%' }}
        />
        <i
          className='good'
          style={{ width: (Math.max(b.delay_with, 0.3) / max) * 100 + '%' }}
        />
      </div>
      <b>
        {b.delay_without} → {b.delay_with} min
      </b>
    </div>
  ))
}

/* ---------------- Login ---------------- */
function Login({ onDone }) {
  const [u, setU] = useState(() => {
    try {
      return localStorage.getItem('curb-agent-remember-username') === 'true'
        ? localStorage.getItem('curb-agent-saved-username') || 'admin'
        : 'admin'
    } catch {
      return 'admin'
    }
  })
  const [p, setP] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [rememberUsername, setRememberUsername] = useState(() => {
    try {
      return localStorage.getItem('curb-agent-remember-username') === 'true'
    } catch {
      return false
    }
  })
  const go = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      const r = await api('/login', 'POST', { username: u, password: p })
      try {
        if (rememberUsername) {
          localStorage.setItem('curb-agent-remember-username', 'true')
          localStorage.setItem('curb-agent-saved-username', u)
        } else {
          localStorage.removeItem('curb-agent-remember-username')
          localStorage.removeItem('curb-agent-saved-username')
        }
      } catch {}
      setToken(r.token)
      onDone()
    } catch (x) {
      setErr(x.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className='login-shell'>
      <div className='login-layout'>
        <section className='login-brand' aria-label='Curb Agent'>
          <div className='login-brand-lockup'>
            <span className='login-brand-mark' aria-hidden='true'>
              C
            </span>
            <span>CURB OPERATIONS</span>
          </div>
          <p className='login-overline'>CAMPUS GATE 02 · OPERATOR ACCESS</p>
          <h1>
            Curb Agent<span>.</span>
          </h1>
          <p className='login-brand-caption'>Bus-priority operations console</p>
        </section>

        <form
          onSubmit={go}
          className='login-panel'
          aria-labelledby='login-title'
        >
          <div className='login-panel-heading'>
            <p className='login-overline'>OPERATOR SIGN-IN</p>
            <h2 id='login-title'>Welcome back</h2>
            <p>Sign in to continue to your workspace.</p>
          </div>

          <label className='login-field' htmlFor='login-username'>
            <span>Username</span>
            <input
              id='login-username'
              name='username'
              autoComplete='username'
              autoCapitalize='none'
              required
              value={u}
              onChange={(e) => setU(e.target.value)}
              placeholder='Enter your username'
            />
          </label>

          <label className='login-field' htmlFor='login-password'>
            <span>Password</span>
            <span className='login-password-field'>
              <input
                id='login-password'
                name='password'
                type={showPassword ? 'text' : 'password'}
                autoComplete='current-password'
                required
                value={p}
                onChange={(e) => setP(e.target.value)}
                placeholder='Enter your password'
              />
              <button
                className='login-password-toggle'
                type='button'
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </span>
          </label>

          <div className='login-options'>
            <label className='login-remember'>
              <input
                type='checkbox'
                checked={rememberUsername}
                onChange={(e) => setRememberUsername(e.target.checked)}
              />
              <span>Remember username</span>
            </label>
          </div>

          {err && (
            <div className='login-error' role='alert'>
              {err}
            </div>
          )}

          <button className='login-submit' type='submit' disabled={busy}>
            <span>{busy ? 'Signing in…' : 'Continue'}</span>
            {!busy && <span aria-hidden='true'>→</span>}
          </button>

          <div className='login-demo'>
            <div>
              <strong>Demo access</strong>
              <small>admin / curb@2026</small>
            </div>
            <button
              type='button'
              className='login-demo-button'
              onClick={() => {
                setU('admin')
                setP('curb@2026')
                setErr('')
              }}
            >
              Use demo account
            </button>
          </div>
          <p className='login-panel-footer'>Curb Agent · Operator workspace</p>
        </form>
      </div>
    </main>
  )
}

function OperatorProfile({ initial, onSaved, onCancel }) {
  const [profile, setProfile] = useState(
    initial || {
      full_name: '',
      role: '',
      email: '',
      phone: '',
      organization: '',
    },
  )
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const result = await api('/profile', 'POST', profile)
      onSaved(result.user)
    } catch (exception) {
      setError(exception.message)
    } finally {
      setSaving(false)
    }
  }
  const update = (key, value) =>
    setProfile((current) => ({ ...current, [key]: value }))
  return (
    <main className='profile-shell'>
      <form className='card profile-form' onSubmit={submit}>
        <p className='eyebrow'>CURB OPERATIONS · OPERATOR SETUP</p>
        <h1>{initial ? 'Your operator details' : 'Welcome to Curb Agent'}</h1>
        <p className='sub'>
          Add the details that will identify your operational actions.
        </p>
        <div className='profile-fields'>
          <label>
            Full name
            <input
              required
              maxLength='100'
              autoComplete='name'
              value={profile.full_name}
              onChange={(e) => update('full_name', e.target.value)}
            />
          </label>
          <label>
            Role / title
            <input
              required
              value={profile.role}
              onChange={(e) => update('role', e.target.value)}
              placeholder='Traffic operations officer'
            />
          </label>
          <label>
            Work email
            <input
              required
              type='email'
              autoComplete='email'
              value={profile.email}
              onChange={(e) => update('email', e.target.value)}
            />
          </label>
          <label>
            Phone
            <input
              required
              type='tel'
              autoComplete='tel'
              value={profile.phone}
              onChange={(e) => update('phone', e.target.value)}
            />
          </label>
          <label>
            Organization
            <input
              required
              maxLength='120'
              autoComplete='organization'
              value={profile.organization}
              onChange={(e) => update('organization', e.target.value)}
            />
          </label>
        </div>
        {error && <div className='err'>{error}</div>}
        <div className='form profile-actions'>
          <button disabled={saving}>
            {saving
              ? initial
                ? 'Saving…'
                : 'Saving and starting agent…'
              : 'Save operator details'}
          </button>
          {onCancel && (
            <button type='button' className='ghost-btn' onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </main>
  )
}

function ActionSummary({ plan, insights, outbox, operator, briefing }) {
  if (!plan || !insights) return null
  const actions = plan.actions || []
  const moved = actions.filter((action) => action.status === 'moved')
  const referred = actions.filter((action) => action.status === 'inspector')
  const kept = actions.filter(
    (action) => action.status === 'kept' || action.status === 'approved',
  )
  const completed = outbox.filter((message) =>
    ['sent', 'confirmed'].includes(message.status),
  )
  const delivered = completed.filter(
    (message) => message.gateway !== 'mock-gateway',
  )
  const simulated = completed.filter(
    (message) => message.gateway === 'mock-gateway',
  )
  const failed = outbox.filter((message) => message.status === 'failed')
  return (
    <section className='card action-summary' aria-live='polite'>
      <div className='summary-heading'>
        <div>
          <p className='eyebrow'>LATEST AGENT RUN</p>
          <h2>Action summary</h2>
        </div>
        <span className='badge ok'>
          {plan.checks?.lockup_free ? 'Plan validated' : 'Review plan checks'}
        </span>
      </div>
      {operator && (
        <p className='summary-operator'>
          Prepared by <b>{operator.full_name}</b> · {operator.role} ·{' '}
          {operator.organization}
        </p>
      )}
      <p className='brief'>{briefing || insights.briefing}</p>
      <div className='summary-stats'>
        <div>
          <strong>{moved.length}</strong>
          <span>re-allocated</span>
        </div>
        <div>
          <strong>{kept.length}</strong>
          <span>kept in place</span>
        </div>
        <div>
          <strong>{referred.length}</strong>
          <span>inspector referrals</span>
        </div>
        <div>
          <strong>{delivered.length}</strong>
          <span>instructions delivered</span>
        </div>
        <div>
          <strong>{simulated.length}</strong>
          <span>demo instructions simulated</span>
        </div>
        <div>
          <strong>{failed.length}</strong>
          <span>notifications failed</span>
        </div>
        <div>
          <strong>{plan.metrics?.bus_delay_saved_min ?? 0} min</strong>
          <span>bus delay avoided</span>
        </div>
      </div>
      {(moved.length > 0 || referred.length > 0 || kept.length > 0) && (
        <div className='summary-decisions'>
          {moved.map((action) => (
            <div key={action.id}>
              <span className='summary-mark moved-mark'>↗</span>
              <b>{action.vendor}</b>
              <span>
                {action.old_slot} {action.old_start} → {action.slot}{' '}
                {action.new_start}
              </span>
            </div>
          ))}
          {referred.map((action) => (
            <div key={action.id}>
              <span className='summary-mark review-mark'>!</span>
              <b>{action.vendor}</b>
              <span>
                Referred to inspector · {action.old_slot} {action.old_start}
              </span>
            </div>
          ))}
          {kept.map((action) => (
            <div key={action.id}>
              <span className='summary-mark kept-mark'>✓</span>
              <b>{action.vendor}</b>
              <span>
                Kept in place · {action.slot} {action.new_start}
              </span>
            </div>
          ))}
        </div>
      )}
      {outbox.length > 0 && (
        <details className='summary-messages'>
          <summary>Notification details ({outbox.length})</summary>
          <div>
            {outbox
              .slice(-5)
              .reverse()
              .map((message) => (
                <article key={message.id}>
                  <span className={'pill ' + message.status}>
                    {message.status}
                  </span>
                  <b>{message.to}</b>
                  <p>{message.text}</p>
                </article>
              ))}
          </div>
        </details>
      )}
    </section>
  )
}

/* ---------------- Workflow stepper ---------------- */
function Workflow({ steps, shown, running }) {
  if (!steps.length && !running)
    return (
      <p className='sub'>Run the agent to start the end-to-end workflow.</p>
    )
  return (
    <ol className='steps'>
      {steps.map((s, i) => (
        <li key={s.name} className={i < shown ? 'done' : 'pending'}>
          <span className='dot'>{i < shown ? '✓' : i + 1}</span>
          <div>
            <b>{s.name}</b>
            {i < shown && <div className='sub'>{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}

/* ---------------- Curfew state visualizer ---------------- */
function CurfewStrip({ data, plan }) {
  const { pct } = winOf(data)
  const rows = [
    ['no_standing', 'No standing'],
    ['freight_window', 'Freight window'],
    ['school_exit', 'School exit (reserved)'],
  ]
  return (
    <div className='cstrip'>
      {rows.map(([k, l]) => (
        <div className='row' key={k}>
          <div className='zl small'>{l}</div>
          <div className='lane thin'>
            {plan.curfews
              .filter((c) => c.type === k)
              .map((c, i) => (
                <div
                  key={i}
                  className={'band ' + k}
                  style={{
                    left: pct(toMin(c.start)) + '%',
                    width: pct(toMin(c.end)) - pct(toMin(c.start)) + '%',
                  }}
                  title={c.text}
                >
                  <span>
                    {c.start}–{c.end}
                  </span>
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---------------- Visual timeline (slots as lanes, with pictures) ---------------- */
function Timeline({ data, plan, now }) {
  const { a, b, pct } = winOf(data)
  const status = Object.fromEntries(
    (plan?.actions || []).map((x) => [x.id, x.status]),
  )
  const hours = []
  for (let h = Math.ceil(a / 60); h * 60 <= b; h++) hours.push(h)
  return (
    <div className='tl'>
      <div className='ticks'>
        {hours.map((h) => (
          <span key={h} style={{ left: pct(h * 60) + '%' }}>
            {h}:00
          </span>
        ))}
      </div>
      {data.slots.map((sl) => (
        <div className='row' key={sl.id}>
          <div className='zl'>
            {sl.label}
            <small>
              {sl.length_m} m · cap {sl.capacity} ·{' '}
              {plan?.grid.find((r) => r.slot === sl.id)?.gate}
            </small>
          </div>
          <div className='lane'>
            {plan?.curfews.map((c, i) => (
              <div
                key={i}
                className={'band ' + c.type}
                style={{
                  left: pct(toMin(c.start)) + '%',
                  width: pct(toMin(c.end)) - pct(toMin(c.start)) + '%',
                }}
                title={c.text}
              />
            ))}
            {plan?.actions
              .filter((x) => x.status === 'moved' && x.old_slot === sl.id)
              .map((x) => (
                <div
                  key={'g' + x.id}
                  className='blk ghost'
                  style={{
                    left: pct(toMin(x.old_start)) + '%',
                    width:
                      pct(toMin(x.old_start) + x.duration) -
                      pct(toMin(x.old_start)) +
                      '%',
                  }}
                  title='Original request'
                >
                  <Pic label={x.vendor} size={18} />
                </div>
              ))}
            {plan?.placed
              .filter((p) => p.slot === sl.id)
              .map((p) =>
                p.kind === 'bus' ? (
                  <Fragment key={p.id}>
                    <div
                      className='blk bus thin'
                      style={{
                        left: pct(p.s) + '%',
                        width: Math.max(pct(p.s + p.dur) - pct(p.s), 0.8) + '%',
                      }}
                      title={`${p.label} ${p.start}-${p.end}`}
                    />
                    <div
                      className='bus-mark'
                      style={{ left: pct(p.s) + '%' }}
                      title={`${p.label} ${p.start}-${p.end}`}
                    >
                      <Pic kind='bus' label={p.label} size={22} />
                      <small>{p.label}</small>
                    </div>
                  </Fragment>
                ) : (
                  <div
                    key={p.id}
                    className={
                      'blk ' + (p.kind === 'booking' ? status[p.id] : p.kind)
                    }
                    style={{
                      left: pct(p.s) + '%',
                      width: pct(p.s + p.dur) - pct(p.s) + '%',
                    }}
                    title={`${p.label} ${p.start}-${p.end}`}
                  >
                    <Pic kind={p.kind} label={p.label} size={24} />
                    <span className='bname'>{p.label}</span>
                  </div>
                ),
              )}
            <div className='nowline' style={{ left: pct(now) + '%' }} />
          </div>
        </div>
      ))}
      <div className='legend'>
        <i className='kept' />
        kept <i className='moved' />
        re-allocated <i className='ghost' />
        original request <i className='incident' />
        incident <i className='bus' />
        bus <i className='no_standing' />
        no standing <i className='freight_window' />
        freight window <i className='school_exit' />
        school exit
      </div>
    </div>
  )
}

/* ---------------- Slot-by-slot occupancy grid ---------------- */
function Grid({ plan, onCellSelect, selectedCell, now }) {
  const n = plan.grid[0].cells.length
  const currentCell = now === undefined ? null : hhmm(Math.floor(now / 15) * 15)
  const cls = (s) =>
    s.includes('school_exit')
      ? 's-exit'
      : s.includes('no_standing')
        ? 's-ns'
        : s.includes('freight_window')
          ? 's-fw'
          : 's-none'
  return (
    <>
      <div
        className='ogrid'
        style={{ gridTemplateColumns: `140px repeat(${n}, minmax(0, 1fr))` }}
      >
        <div className='gh' />
        {plan.grid[0].cells.map((c, i) => (
          <div
            key={i}
            className={'gh' + (c.t === currentCell ? ' current-time' : '')}
          >
            {c.t.endsWith(':00') || i === 0 ? c.t : ''}
          </div>
        ))}
        <div className='gl'>Curfew state</div>
        {plan.curfew_states.map((c, i) => (
          <div
            key={i}
            className={'gc ' + cls(c.states)}
            title={`${c.t} · ${c.states.join(', ').replace(/_/g, ' ') || 'no restriction'}`}
          />
        ))}
        {plan.grid.map((r) => (
          <Fragment key={r.slot}>
            <div className='gl'>
              {r.label}
              <small>
                {r.from_m}–{r.to_m} m · cap {r.capacity} · {r.gate}
              </small>
            </div>
            {r.cells.map((c, i) => (
              <div
                key={i}
                className={
                  'gc k-' +
                  c.k +
                  (c.t === currentCell ? ' current-time' : '') +
                  (selectedCell?.slot === r.slot && selectedCell?.start === c.t
                    ? ' selected'
                    : '') +
                  (onCellSelect && c.k === 'free' ? ' selectable' : '')
                }
                title={`${c.t} · ${c.label || 'free'}`}
                role={onCellSelect && c.k === 'free' ? 'button' : undefined}
                tabIndex={onCellSelect && c.k === 'free' ? 0 : undefined}
                onClick={
                  onCellSelect && c.k === 'free'
                    ? () => onCellSelect(r.slot, c.t)
                    : undefined
                }
                onKeyDown={
                  onCellSelect && c.k === 'free'
                    ? (e) => e.key === 'Enter' && onCellSelect(r.slot, c.t)
                    : undefined
                }
              />
            ))}
          </Fragment>
        ))}
      </div>
      <div className='legend'>
        <i className='k-free' />
        free <i className='k-bus' />
        bus <i className='k-kept' />
        kept <i className='k-moved' />
        re-allocated <i className='k-incident' />
        incident · curfew row: <i className='s-ns' />
        no standing <i className='s-fw' />
        freight window <i className='s-exit' />
        school exit
      </div>
    </>
  )
}

function InspectorPanel({ data, plan, act, now }) {
  const pending = (plan?.actions || []).filter((a) => a.status === 'inspector')
  const [activeId, setActiveId] = useState('')
  const active = pending.find((a) => a.id === activeId) || pending[0]
  const [target, setTarget] = useState({ slot_id: '', start: '' })
  useEffect(() => {
    if (active) setTarget({ slot_id: active.old_slot, start: active.old_start })
  }, [active?.id])
  const decide = (decision) =>
    active &&
    act(() =>
      api(`/inspector/${active.id}`, 'POST', {
        decision,
        ...(decision === 'approved' ? target : {}),
      }),
    )
  return (
    <section className='card inspector-panel mx-auto w-full max-w-7xl'>
      <div className='inspector-heading'>
        <div>
          <h2>Inspector overrides</h2>
          <p className='sub'>
            Unknown entities remain unassigned until a human decision is
            recorded.
          </p>
        </div>
        <span className='pill'>{pending.length} pending</span>
      </div>
      {!plan ? (
        <p className='sub'>Run the agent to review referrals.</p>
      ) : !pending.length ? (
        <p className='okbox'>No requests are waiting for inspector review.</p>
      ) : (
        <div className='inspector-layout'>
          <div
            className='inspector-queue'
            aria-label='Pending inspector requests'
          >
            {pending.map((a) => (
              <button
                key={a.id}
                className={
                  'inspector-request ' + (active?.id === a.id ? 'active' : '')
                }
                onClick={() => setActiveId(a.id)}
              >
                <Pic label={a.vendor} size={28} />
                <span>
                  <b>{a.vendor}</b>
                  <small>
                    {a.vehicle_type} · {a.old_slot} · {a.old_start} ·{' '}
                    {a.duration} min
                  </small>
                </span>
                <span aria-hidden='true'>›</span>
              </button>
            ))}
          </div>
          {active && (
            <div className='inspector-detail'>
              <h3>Review {active.vendor}</h3>
              <p>{active.reasons.map((r) => r.text).join(' ')}</p>
              <div className='form'>
                <label>
                  Approve at{' '}
                  <select
                    value={target.slot_id}
                    onChange={(e) =>
                      setTarget({ ...target, slot_id: e.target.value })
                    }
                  >
                    {data.slots.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label} · {s.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Arrival{' '}
                  <input
                    type='time'
                    value={target.start}
                    onChange={(e) =>
                      setTarget({ ...target, start: e.target.value })
                    }
                  />
                </label>
                <button onClick={() => decide('approved')}>
                  Approve selected slot
                </button>
                <button
                  className='reject-btn'
                  onClick={() => decide('rejected')}
                >
                  Reject
                </button>
                <button
                  className='remove-request-btn'
                  onClick={() =>
                    act(() => api(`/bookings/${active.id}`, 'DELETE'))
                  }
                  title='Remove this booking from the plan and inspector queue'
                >
                  Remove request
                </button>
              </div>
              <p className='sub'>
                Or choose a free 15-minute cell; approval still respects curb
                capacity and the six-hour window.
              </p>
              <div className='inspector-grid'>
                <Grid
                  plan={plan}
                  now={now}
                  onCellSelect={(slot_id, start) =>
                    setTarget({ slot_id, start })
                  }
                  selectedCell={target}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function CurfewAdmin({ data, act }) {
  const current =
    data.curfew_overrides?.freight_window ||
    data.rules.find((r) => r.type === 'freight_window') ||
    {}
  const [start, setStart] = useState(current.start || '11:00')
  const [end, setEnd] = useState(current.end || '13:00')
  useEffect(() => {
    setStart(current.start || '11:00')
    setEnd(current.end || '13:00')
  }, [current.start, current.end])
  return (
    <section className='curfew-admin'>
      <div>
        <b>Operational freight window</b>
        <small>
          {data.curfew_overrides?.freight_window
            ? 'Temporary override active'
            : 'Rulebook default'}{' '}
          · updates recalculate the plan immediately
        </small>
      </div>
      <form
        className='form'
        onSubmit={(e) => {
          e.preventDefault()
          act(() => api('/curfews/freight-window', 'PUT', { start, end }))
        }}
      >
        <label>
          From{' '}
          <input
            type='time'
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          Until{' '}
          <input
            type='time'
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <button>Apply and replan</button>
      </form>
    </section>
  )
}

function DwellRecorder({ data, act }) {
  const [bus, setBus] = useState(data.bus_trace[0]?.id || '')
  const [duration, setDuration] = useState(8)
  return (
    <form
      className='form dwell-recorder'
      onSubmit={(e) => {
        e.preventDefault()
        act(() => api('/buses/dwell', 'POST', { bus, dwell_min: duration }))
      }}
    >
      <b>Observed bus dwell</b>
      <select value={bus} onChange={(e) => setBus(e.target.value)}>
        {[...new Set(data.bus_trace.map((b) => b.id))].map((id) => (
          <option key={id}>{id}</option>
        ))}
      </select>
      <input
        aria-label='Observed dwell minutes'
        type='number'
        min='1'
        max='180'
        value={duration}
        onChange={(e) => setDuration(+e.target.value)}
      />
      <span className='sub'>min</span>
      <button className='ghost-btn'>Record and replan</button>
    </form>
  )
}

/* ---------------- "Now" panel for the time simulator ---------------- */
function NowPanel({ data, plan, now }) {
  if (!plan) return null
  const label = (id) => data.slots.find((s) => s.id === id)?.label
  const onCurb = plan.placed.filter((p) => p.s <= now && now < p.s + p.dur)
  const busNow = data.bus_trace.find(
    (b) => toMin(b.arrives) <= now && now < toMin(b.arrives) + b.dwell_min,
  )
  const next = data.bus_trace
    .filter((b) => toMin(b.arrives) > now)
    .sort((x, y) => toMin(x.arrives) - toMin(y.arrives))[0]
  const active = plan.curfews.filter(
    (c) => toMin(c.start) <= now && now < toMin(c.end),
  )
  return (
    <div className='nowpanel'>
      <h3>At {hhmm(now)}</h3>
      <div>
        {busNow ? (
          <b>
            {busNow.id} to {busNow.destination} is at the bus bay
          </b>
        ) : next ? (
          <>
            Next bus: <b>{next.id}</b> to {next.destination} at {next.arrives}
          </>
        ) : (
          'No more buses in this window'
        )}
      </div>
      <div>
        {onCurb.length
          ? onCurb.map((p) => `${p.label} (${label(p.slot)})`).join(', ')
          : 'No vehicles on the curb'}
      </div>
      <div>
        {active.length
          ? 'Active: ' + active.map((c) => c.text).join(' ')
          : 'No restrictions active'}
      </div>
    </div>
  )
}

/* ---------------- Bookings + incidents + scenarios ---------------- */
function Bookings({ data, refresh, setMsg, run }) {
  const [f, setF] = useState({
    vendor: '',
    vehicle_type: 'freight',
    slot_id: data.slots.find((s) => s.type === 'general')?.id,
    start: '11:00',
    duration: 30,
  })
  const [inc, setInc] = useState({
    slot_id: data.slots.find((s) => s.type === 'bus_bay')?.id,
    start: '09:38',
    duration: 15,
    reason: 'Car broke down in bus bay',
  })
  const act = async (fn, runAgent = false) => {
    try {
      await fn()
      setMsg('')
      if (runAgent) await run()
      else await refresh()
    } catch (e) {
      setMsg(e.message)
    }
  }
  const apply = async (s) => {
    try {
      await api(
        s.kind === 'incident' ? '/incidents' : '/bookings',
        'POST',
        s.body,
      )
      await run()
    } catch (e) {
      setMsg(e.message)
    }
  }
  const slotSel = (v, on) => (
    <select value={v} onChange={(e) => on(e.target.value)}>
      {data.slots.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label} ({s.id})
        </option>
      ))}
    </select>
  )
  return (
    <>
      <section className='card'>
        <h2>
          Demo scenarios{' '}
          <small>(applies the change and re-runs the agent)</small>
        </h2>
        <div className='presets'>
          {SCENARIOS.map((s) => (
            <button
              key={s.label}
              className='ghost-btn'
              onClick={() => apply(s)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </section>
      <section className='card'>
        <h2>Bookings</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Vendor</th>
              <th>Vehicle</th>
              <th>Slot</th>
              <th>Start</th>
              <th>Min</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.bookings.map((b) => (
              <tr key={b.id}>
                <td>{b.id}</td>
                <td>
                  <span className='dpic'>
                    <Pic label={b.vendor} size={20} />
                    {b.vendor}
                  </span>
                </td>
                <td>{b.vehicle_type}</td>
                <td>{b.slot_id}</td>
                <td>{b.start}</td>
                <td>{b.duration}</td>
                <td>
                  <button
                    className='link'
                    onClick={() =>
                      act(() => api('/bookings/' + b.id, 'DELETE'), true)
                    }
                  >
                    remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className='form'>
          <input
            placeholder='Vendor / driver'
            value={f.vendor}
            onChange={(e) => setF({ ...f, vendor: e.target.value })}
          />
          <select
            value={f.vehicle_type}
            onChange={(e) => setF({ ...f, vehicle_type: e.target.value })}
          >
            <option value='freight'>freight (tempo)</option>
            <option value='personal'>personal</option>
            <option value='bus'>bus</option>
          </select>
          {slotSel(f.slot_id, (v) => setF({ ...f, slot_id: v }))}
          <input
            type='time'
            value={f.start}
            onChange={(e) => setF({ ...f, start: e.target.value })}
          />
          <input
            type='number'
            value={f.duration}
            onChange={(e) => setF({ ...f, duration: +e.target.value })}
          />
          <button onClick={() => act(() => api('/bookings', 'POST', f), true)}>
            Add booking
          </button>
        </div>
      </section>
      <section className='card'>
        <h2>Live incidents</h2>
        {data.incidents.length === 0 && <p className='sub'>None reported.</p>}
        {data.incidents.map((i, n) => (
          <div key={n} className='rule warn'>
            <span className='dpic'>
              <Pic kind='incident' label='incident' size={18} />
              {i.reason} — {i.slot_id} {i.start} ({i.duration} min)
            </span>
          </div>
        ))}
        <div className='form'>
          {slotSel(inc.slot_id, (v) => setInc({ ...inc, slot_id: v }))}
          <input
            type='time'
            value={inc.start}
            onChange={(e) => setInc({ ...inc, start: e.target.value })}
          />
          <input
            type='number'
            value={inc.duration}
            onChange={(e) => setInc({ ...inc, duration: +e.target.value })}
          />
          <input
            value={inc.reason}
            onChange={(e) => setInc({ ...inc, reason: e.target.value })}
          />
          <button
            onClick={() => act(() => api('/incidents', 'POST', inc), true)}
          >
            Report incident
          </button>
          {data.incidents.length > 0 && (
            <button
              className='ghost-btn'
              onClick={() => act(() => api('/incidents', 'DELETE'), true)}
            >
              Clear
            </button>
          )}
        </div>
        <p className='sub'>
          Inputs are schema-validated. After changing anything, run the agent
          again.
        </p>
      </section>
    </>
  )
}

function LiveIngestion({ data, gpsStatus }) {
  const points = [...(data.live_gps || [])].reverse()
  const vehicles = new Set(points.map((point) => point.vehicle_id)).size
  return (
    <section className='card live-feed'>
      <div className='inspector-heading'>
        <div>
          <h2>Live GPS stream</h2>
          <p className='sub'>
            Mock bus and delivery-vehicle coordinates received continuously over
            the authenticated WebSocket.
          </p>
        </div>
        <span className='badge ok'>{gpsStatus}</span>
      </div>
      <div className='tiles'>
        <div>
          <big>{points.length}</big>recent position updates
        </div>
        <div>
          <big>{vehicles}</big>active vehicle IDs
        </div>
        <div>
          <big>{new Set(points.map((point) => point.gate)).size}</big>gates
          represented
        </div>
      </div>
      {!points.length ? (
        <p className='sub'>Waiting for the first GPS frame…</p>
      ) : (
        <div className='table-scroll'>
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Vehicle</th>
                <th>Type</th>
                <th>Gate</th>
                <th>Latitude</th>
                <th>Longitude</th>
                <th>Speed</th>
                <th>Traffic</th>
                <th>Delay</th>
              </tr>
            </thead>
            <tbody>
              {points.slice(0, 30).map((point, index) => (
                <tr key={`${point.vehicle_id}-${point.received_at}-${index}`}>
                  <td>{point.received_at}</td>
                  <td>{point.vehicle_id}</td>
                  <td>{point.vehicle_type}</td>
                  <td>{point.gate}</td>
                  <td>{point.lat.toFixed(5)}</td>
                  <td>{point.lon.toFixed(5)}</td>
                  <td>
                    {point.speed_kmh ?? '—'}
                    {point.speed_kmh == null ? '' : ' km/h'}
                  </td>
                  <td>{point.traffic_level || '—'}</td>
                  <td>
                    {point.delay_min > 0
                      ? `+${point.delay_min} min`
                      : point.delay_min < 0
                        ? `${Math.abs(point.delay_min)} min early`
                        : 'On time'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function TrafficPanel({ traffic = {} }) {
  const rows = Object.values(traffic).sort((a, b) =>
    a.vehicle_id.localeCompare(b.vehicle_id),
  )
  return (
    <section className='traffic-panel' aria-live='polite'>
      <div>
        <b>Live traffic adjustments</b>
        <small>Plan arrival times follow GPS speed/delay updates.</small>
      </div>
      {!rows.length ? (
        <span className='sub'>Waiting for traffic telemetry</span>
      ) : (
        rows.map((item) => (
          <div
            className={'traffic-row traffic-' + item.traffic_level}
            key={item.vehicle_id}
          >
            <b>{item.vehicle_id}</b>
            <span>{item.gate}</span>
            <strong>{item.traffic_level}</strong>
            <span>
              {item.delay_min > 0
                ? `+${item.delay_min} min`
                : item.delay_min < 0
                  ? `${Math.abs(item.delay_min)} min early`
                  : 'On time'}
            </span>
            {item.speed_kmh != null && <span>{item.speed_kmh} km/h</span>}
            {item.predicted_arrival && (
              <span>ETA {item.predicted_arrival}</span>
            )}
            {item.predicted_start && <span>Slot {item.predicted_start}</span>}
          </div>
        ))
      )}
    </section>
  )
}

/* ---------------- Data ingestion & schema validation ---------------- */
function Ingestion({ refresh }) {
  const [rep, setRep] = useState(null),
    [text, setText] = useState(''),
    [res, setRes] = useState(null)
  const load = async () => setRep(await api('/validate'))
  useEffect(() => {
    load().catch((e) => setRes({ ok: false, errors: [e.message] }))
  }, [])
  const submit = async (dry) => {
    try {
      const r = await api('/ingest/scenario', 'POST', {
        scenario: JSON.parse(text),
        dry_run: dry,
      })
      setRes(r)
      if (r.ok && !dry) {
        await refresh()
        await load()
      }
    } catch (e) {
      setRes({ ok: false, errors: [e.message] })
    }
  }
  if (!rep)
    return (
      <section className='card'>
        <p className='sub'>Validating…</p>
      </section>
    )
  const sc = rep.scenario,
    rb = rep.rulebook
  return (
    <>
      <section className='card'>
        <h2>Ingestion &amp; schema validation</h2>
        <div className='tiles'>
          <div>
            <big>{rb.ok ? '✓ valid' : '✗ invalid'}</big>rulebook.json v
            {rb.version} · {rb.rules} rules
          </div>
          <div>
            <big>{sc.ok ? '✓ valid' : '✗ invalid'}</big>scenario.json ·{' '}
            {sc.counts.slots} slots, {sc.counts.bus_trace} bus arrivals,{' '}
            {sc.counts.bookings} bookings
          </div>
          <div>
            <big>
              {sc.curb_length_used_m} / {sc.curb_length_m} m
            </big>
            curb boundary used
          </div>
          <div>
            <big>
              {sc.plan_window.start}–{sc.plan_window.end}
            </big>
            plan window (6 h)
          </div>
        </div>
        <div className='ubar'>
          <span>Curb length</span>
          <div>
            <i
              style={{
                width:
                  Math.min(
                    100,
                    (sc.curb_length_used_m / sc.curb_length_m) * 100,
                  ) + '%',
              }}
            />
          </div>
          <b>
            {sc.curb_length_used_m}/{sc.curb_length_m} m
          </b>
        </div>
        {sc.errors.map((e, i) => (
          <div key={i} className='err'>
            {e}
          </div>
        ))}
        <h3>What the validator checks</h3>
        <ul className='recs'>
          {rep.checked.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>
      <section className='card'>
        <h2>Load a different scenario.json</h2>
        <p className='sub'>
          Vehicle types: bus / freight / personal · slot types: bus_bay /
          general. Nothing is loaded unless it passes validation.
        </p>
        <div className='form'>
          <button
            className='ghost-btn'
            onClick={async () =>
              setText(JSON.stringify(await api('/scenario'), null, 2))
            }
          >
            Load current scenario into editor
          </button>
          <button
            className='ghost-btn'
            onClick={() => submit(true)}
            disabled={!text}
          >
            Validate only
          </button>
          <button onClick={() => submit(false)} disabled={!text}>
            Validate &amp; load
          </button>
        </div>
        <textarea
          className='code'
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='Paste scenario.json here'
        />
        {res &&
          (res.ok ? (
            <div className='okbox'>
              ✓ Scenario is valid
              {res.loaded
                ? ' and has been loaded. Bookings and the plan were reset.'
                : '.'}
            </div>
          ) : (
            res.errors.map((e, i) => (
              <div key={i} className='err'>
                {e}
              </div>
            ))
          ))}
      </section>
    </>
  )
}

/* ---------------- Guardrails, rule checker, ask ---------------- */
function Guardrails({ data }) {
  const rb = data.rulebook,
    plan = data.plan
  const [c, setC] = useState({
    vehicle_type: 'freight',
    slot_id: data.slots[0].id,
    start: '12:00',
    duration: 20,
  })
  const [res, setRes] = useState(null),
    [err, setErr] = useState('')
  const [q, setQ] = useState(''),
    [ans, setAns] = useState(null)
  const inspector = plan
    ? plan.actions.filter((a) => a.status === 'inspector').length
    : 0
  const blocked = plan?.guardrail.blocked_actions.length || 0
  const items = [
    [
      'Rulebook is immutable law',
      rb.hash_verified
        ? `sha256 ${rb.hash.slice(0, 16)}… verified unchanged`
        : 'FILE CHANGED: runs are blocked',
    ],
    [
      'No invented bye-laws',
      `every action must cite a real rule id (${blocked} blocked this run)`,
    ],
    [
      'No towing or impoundment',
      `forbidden: ${rb.forbidden_actions.join(', ')}; all SMS/briefings are screened (${data.guard_log.length} blocked so far)`,
    ],
    [
      'Inspection fallback',
      `${inspector} request(s) not covered by the rulebook → “${INSPECTOR}”`,
    ],
  ]
  const verdict = async () => {
    try {
      setErr('')
      setRes(await api('/check', 'POST', c))
    } catch (e) {
      setRes(null)
      setErr(e.message)
    }
  }
  return (
    <>
      <section className='card'>
        <h2>Policy guardrails</h2>
        <div className='gr'>
          {items.map(([t, d]) => (
            <div key={t} className='grow'>
              <span className='tick'>✓</span>
              <div>
                <b>{t}</b>
                <div className='sub'>{d}</div>
              </div>
            </div>
          ))}
        </div>
        <h3>
          Rulebook v{rb.version} <small>(read-only)</small>
        </h3>
        {data.rules.map((r) => (
          <div key={r.id} className='rule'>
            <b>{r.id}</b> {r.text}{' '}
            <small>
              ({r.type.replace(/_/g, ' ')} · {r.vehicle_types.join(', ')})
            </small>
          </div>
        ))}
        <h3>Blocked by the guardrails</h3>
        {data.guard_log.length === 0 ? (
          <p className='sub'>Nothing has needed blocking.</p>
        ) : (
          [...data.guard_log].reverse().map((g, i) => (
            <div key={i} className='logrow'>
              <small>{g.ts}</small> <b>{g.kind}</b> {g.reason}{' '}
              <small>“{g.snippet}”</small>
            </div>
          ))
        )}
      </section>
      <section className='card'>
        <h2>
          Rule checker <small>(instant, no LLM)</small>
        </h2>
        <div className='form'>
          <select
            value={c.vehicle_type}
            onChange={(e) => setC({ ...c, vehicle_type: e.target.value })}
          >
            <option value='freight'>freight</option>
            <option value='personal'>personal</option>
            <option value='bus'>bus</option>
          </select>
          <select
            value={c.slot_id}
            onChange={(e) => setC({ ...c, slot_id: e.target.value })}
          >
            {data.slots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.id})
              </option>
            ))}
          </select>
          <input
            type='time'
            value={c.start}
            onChange={(e) => setC({ ...c, start: e.target.value })}
          />
          <input
            type='number'
            value={c.duration}
            onChange={(e) => setC({ ...c, duration: +e.target.value })}
          />
          <button onClick={verdict}>Check</button>
        </div>
        {err && <div className='err'>{err}</div>}
        {res && (
          <div className={'verdict ' + res.verdict}>
            <b>{res.verdict.replace(/_/g, ' ')}</b> {res.message}
          </div>
        )}
      </section>
      <section className='card'>
        <h2>
          Ask the rulebook <small>(llama3.2:3b)</small>
        </h2>
        <div className='form'>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder='Can a cycle rickshaw stop at 10am?'
          />
          <button
            onClick={async () =>
              setAns(await api('/ask', 'POST', { question: q }))
            }
          >
            Ask
          </button>
        </div>
        {ans && <div className='rule'>{ans.answer}</div>}
      </section>
    </>
  )
}

/* ---------------- SMS outbox ---------------- */
function Outbox({ outbox, act, now }) {
  const [replies, setReplies] = useState({})
  if (!outbox.length)
    return (
      <section className='card'>
        <h2>SMS outbox</h2>
        <p className='sub'>No messages yet. Run the agent.</p>
      </section>
    )
  return (
    <section className='card'>
      <h2>
        SMS outbox <small>(drafted and sent automatically)</small>
      </h2>
      {outbox.map((o) => (
        <div key={o.id} className={'sms ' + o.status}>
          <div className='smshead'>
            <Pic
              kind={o.kind === 'bus_dispatch' ? 'bus' : 'booking'}
              label={o.to}
              size={22}
            />
            <b>To {o.to}</b> <small>{o.phone}</small>
            <span className='pill'>
              {o.kind === 'bus_dispatch'
                ? 'bus dispatch confirmation'
                : 'tempo re-routing'}
            </span>
            <span className={'pill ' + o.status}>{o.status}</span>
          </div>
          <p>{o.text}</p>
          <small>
            drafted by {o.source}
            {o.gateway && ` · sent via ${o.gateway} at ${o.ts}`}
          </small>
          <div>
            {(o.status === 'draft' || o.status === 'failed') && (
              <button
                onClick={() =>
                  act(() =>
                    api(`/outbox/${o.id}/send`, 'POST', {
                      current_time: hhmm(now),
                    }),
                  )
                }
              >
                {o.status === 'failed' ? 'Retry' : 'Send'}
              </button>
            )}
            {o.status === 'sent' && (
              <div className='reply-form'>
                <input
                  value={replies[o.id] ?? 'OK'}
                  onChange={(e) =>
                    setReplies({ ...replies, [o.id]: e.target.value })
                  }
                  aria-label={`Reply from ${o.to}`}
                  placeholder='Driver reply'
                />
                <button
                  className='ghost-btn'
                  onClick={() =>
                    act(() =>
                      api(`/outbox/${o.id}/reply`, 'POST', {
                        message: replies[o.id] ?? 'OK',
                      }),
                    )
                  }
                >
                  Simulate reply
                </button>
              </div>
            )}
            {o.reallocation && (
              <div className='okbox'>
                Late arrival parsed: booking moved to {o.reallocation.start} (+
                {o.reallocation.late_min} min).
              </div>
            )}
          </div>
        </div>
      ))}
    </section>
  )
}

function AuditLog({ data }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const generate = async () => {
    try {
      const result = await api(`/audit/daily?date=${encodeURIComponent(date)}`)
      setReport(result)
      setError('')
      downloadCsv(`curb-compliance-${date}.csv`, [
        ['Created at', 'Event type', 'Actor', 'Payload'],
        ...result.events.map((event) => [
          event.createdAt,
          event.eventType,
          event.actor,
          JSON.stringify(event.payload),
        ]),
      ])
    } catch (e) {
      setError(e.message)
    }
  }
  return (
    <section className='card'>
      <h2>Audit log</h2>
      <div className='form'>
        <label>
          Report date{' '}
          <input
            type='date'
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <button onClick={generate}>Generate daily compliance report</button>
      </div>
      {error && <div className='err'>{error}</div>}
      {report && (
        <div className='rule'>
          <b>{report.date}</b> · {report.events.length} persisted events ·{' '}
          {Object.entries(report.totals)
            .map(([name, count]) => `${name}: ${count}`)
            .join(' · ') || 'no events'}
        </div>
      )}
      {data.log.length === 0 && <p className='sub'>Nothing yet.</p>}
      {[...data.log].reverse().map((l, i) => (
        <div key={i} className='logrow'>
          <small>{l.ts}</small> <b>{l.user}</b> {l.event}
        </div>
      ))}
    </section>
  )
}

/* ---------------- Main app ---------------- */
const CLASH_LABEL = {
  school_bus: 'School-bus clash',
  bus_bay: 'Bus-bay clash',
  school_exit: 'School-exit overlap',
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('curb-agent-theme') === 'dark'
        ? 'dark'
        : 'light'
    } catch {
      return 'light'
    }
  })
  const [authed, setAuthed] = useState(hasToken())
  const [data, setData] = useState(null)
  const [editingProfile, setEditingProfile] = useState(false)
  const [tab, setTab] = useState('workflow')
  const [busy, setBusy] = useState(false),
    [useLlm, setUseLlm] = useState(true),
    [autoReply, setAutoReply] = useState(true),
    [shown, setShown] = useState(null)
  const [msg, setMsg] = useState('')
  const [now, setNow] = useState(null),
    [playing, setPlaying] = useState(false)
  const [gpsStatus, setGpsStatus] = useState('Connecting GPS stream')
  const [toasts, setToasts] = useState([])
  const lastClock = useRef(null)
  const seenAlerts = useRef(new Set())
  const derivedClock = data ? (now ?? toMin(data.plan_window.start)) : null
  const liveClock = useRef(derivedClock)
  liveClock.current = derivedClock

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('curb-agent-theme', theme)
    } catch {}
  }, [theme])

  const refresh = async () => {
    const d = await api('/state')
    setData(d)
    setNow((n) => n ?? toMin(d.plan_window.start))
  }
  const run = async () => {
    setBusy(true)
    setShown(0)
    setMsg('')
    try {
      const currentTime = data
        ? hhmm(now ?? toMin(data.plan_window.start))
        : undefined
      const r = await api('/workflow/run', 'POST', {
        use_llm: useLlm,
        auto_reply: autoReply,
        current_time: currentTime,
      })
      setData((current) => ({
        ...current,
        plan: r.plan,
        steps: r.steps,
        outbox: r.outbox,
        insights: r.insights,
        last_agent_briefing: r.last_agent_briefing,
        guard_log: r.guard_log,
      }))
      r.steps.forEach((_, i) =>
        setTimeout(() => setShown(i + 1), 350 * (i + 1)),
      )
      await refresh()
    } catch (e) {
      setMsg(e.message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (authed) refresh().catch((e) => setMsg(e.message))
  }, [authed])
  useEffect(() => {
    if (!authed) return
    const socket = new WebSocket(
      websocketUrl(
        `/api/ws/live?token=${encodeURIComponent(localStorage.getItem('token') || '')}`,
      ),
    )
    const vehicles = [
      {
        vehicle_id: 'B12',
        vehicle_type: 'bus',
        gate: 'Gate 2',
        scheduled_arrival: '07:45',
      },
      {
        vehicle_id: 'T1',
        vehicle_type: 'freight',
        gate: 'Gate 3',
        booking_id: 'T1',
      },
      {
        vehicle_id: 'B21',
        vehicle_type: 'bus',
        gate: 'Gate 2',
        scheduled_arrival: '12:30',
      },
    ]
    let sequence = 0
    let timer
    socket.onopen = () => {
      setGpsStatus('Live GPS stream')
      const emit = () => {
        if (socket.readyState !== WebSocket.OPEN) return
        const vehicle = vehicles[sequence % vehicles.length]
        const delayProfile = [0, 4, 10, 10, 4, 0]
        const delay =
          delayProfile[
            Math.floor(sequence / vehicles.length) % delayProfile.length
          ]
        socket.send(
          JSON.stringify({
            ...vehicle,
            lat: 13.04 + sequence * 0.0001,
            lon: 80.23 + sequence * 0.00008,
            speed_kmh: delay >= 10 ? 7 : delay ? 16 : 32,
            traffic_level: delay >= 10 ? 'heavy' : delay ? 'moderate' : 'free',
            delay_min: delay,
            simulation_time: hhmm(liveClock.current ?? 450),
          }),
        )
        sequence += 1
      }
      emit()
      timer = window.setInterval(emit, 3000)
    }
    socket.onmessage = (message) => {
      setGpsStatus('Live GPS stream · receiving')
      try {
        const payload = JSON.parse(message.data)
        if (payload.point)
          setData((current) =>
            current
              ? {
                  ...current,
                  live_gps: [...(current.live_gps || []), payload.point].slice(
                    -100,
                  ),
                  traffic: payload.traffic || current.traffic,
                  bus_trace: payload.bus_trace || current.bus_trace,
                  bookings: payload.bookings || current.bookings,
                  plan: payload.plan || current.plan,
                  insights: payload.insights || current.insights,
                }
              : current,
          )
        if (payload.replanned)
          setGpsStatus('Traffic changed · plan recalculated')
      } catch {
        setGpsStatus('GPS update could not be read')
      }
    }
    socket.onerror = () => setGpsStatus('GPS stream unavailable')
    socket.onclose = () => {
      window.clearInterval(timer)
      setGpsStatus('GPS stream offline')
    }
    return () => {
      window.clearInterval(timer)
      socket.close()
    }
  }, [authed])
  useEffect(() => {
    if (!data?.plan || derivedClock === null) return
    const previous = lastClock.current
    const add = (key, text, at) => {
      if (seenAlerts.current.has(key)) return
      seenAlerts.current.add(key)
      const id = `${Date.now()}-${key}`
      setToasts((items) => [...items, { id, text, at }].slice(-4))
      window.setTimeout(
        () => setToasts((items) => items.filter((item) => item.id !== id)),
        5000,
      )
    }
    if (previous === null || derivedClock >= previous) {
      data.plan.actions
        .filter((action) => action.status === 'inspector')
        .forEach((action) =>
          add(
            `inspector-${action.id}`,
            `Inspector review requested: ${action.vendor}`,
            hhmm(derivedClock),
          ),
        )
      data.plan.clashes
        .filter((c) => c.at)
        .forEach((c, i) => {
          const at = toMin(c.at)
          if (
            (previous === null && at <= derivedClock) ||
            (previous !== null && previous < at && at <= derivedClock)
          )
            add(`clash-${i}-${c.at}`, `Clash detected: ${c.text}`, c.at)
        })
      data.outbox
        .filter((o) => o.event_time)
        .forEach((o) => {
          const at = toMin(o.event_time)
          if (
            (previous === null && at <= derivedClock) ||
            (previous !== null &&
              ((previous < at && at <= derivedClock) || at === derivedClock))
          )
            add(`sms-${o.id}`, `SMS dispatched to ${o.to}`, o.event_time)
        })
    }
    lastClock.current = derivedClock
  }, [derivedClock, data?.plan, data?.outbox])
  useEffect(() => {
    if (!playing || !data) return
    const end = winOf(data).b
    const id = setInterval(
      () =>
        setNow((n) => {
          if (n >= end) {
            setPlaying(false)
            return end
          }
          return n + 2
        }),
      150,
    )
    return () => clearInterval(id)
  }, [playing, data])
  if (!authed) return <Login onDone={() => setAuthed(true)} />
  if (!data)
    return (
      <p className='wrap'>Loading… is the backend running on :8000? {msg}</p>
    )
  if (!data.user?.profile || editingProfile)
    return (
      <OperatorProfile
        initial={data.user?.profile}
        onSaved={async (user) => {
          const firstSetup = !data.user?.profile
          setData((current) => ({ ...current, user }))
          setEditingProfile(false)
          if (firstSetup) await run()
        }}
        onCancel={
          data.user?.profile ? () => setEditingProfile(false) : undefined
        }
      />
    )

  const W = winOf(data),
    clock = now ?? W.a
  const act = async (fn) => {
    try {
      await fn()
      await refresh()
      setMsg('')
    } catch (e) {
      setMsg(e.message)
    }
  }
  const plan = data.plan,
    m = plan?.metrics,
    steps = data.steps || []
  const count = (s) =>
    plan ? plan.actions.filter((a) => a.status === s).length : 0
  const sentCount = data.outbox.filter(
    (o) =>
      (o.status === 'sent' || o.status === 'confirmed') &&
      o.gateway !== 'mock-gateway',
  ).length
  const confirmed = data.outbox.filter(
    (o) => o.status === 'confirmed' && o.gateway !== 'mock-gateway',
  ).length
  const tabs = [
    ['workflow', 'Workflow'],
    ['plan', '6-hour plan'],
    [
      'inspector',
      `Inspector (${plan?.actions.filter((a) => a.status === 'inspector').length || 0})`,
    ],
    ['bookings', 'Bookings & scenarios'],
    ['ingest', 'Live GPS'],
    ['guard', 'Guardrails & rules'],
    ['sms', `SMS outbox (${data.outbox.length})`],
    ['log', 'Audit log'],
  ]
  const exportDecisions = () =>
    downloadCsv('curb-decisions.csv', [
      [
        'Vendor',
        'Vehicle',
        'Status',
        'Action',
        'Was',
        'Now',
        'Reasons',
        'Reroute',
        'Circling km avoided',
      ],
      ...plan.actions.map((a) => [
        a.vendor,
        a.vehicle_type,
        a.status,
        a.action,
        `${a.old_slot} ${a.old_start}`,
        a.status === 'inspector' ? INSPECTOR : `${a.slot} ${a.new_start}`,
        a.reasons.map((r) => `${r.rule}: ${r.text}`).join(' | '),
        a.reroute,
        a.circling_km_avoided,
      ]),
    ])
  const exportSms = () =>
    downloadCsv('curb-sms-log.csv', [
      ['Type', 'To', 'Phone', 'Status', 'Sent at', 'Message'],
      ...data.outbox.map((o) => [
        o.kind,
        o.to,
        o.phone,
        o.status,
        o.ts,
        o.text,
      ]),
    ])

  return (
    <div className='wrap'>
      <header>
        <div>
          <h1>🚌 Bus-priority &amp; curb-window agent</h1>
          <p className='sub'>
            {data.campus} · <span className='gps-status'>{gpsStatus}</span>
          </p>
          <p className='operator-line'>
            <strong>{data.user.profile.full_name}</strong> ·{' '}
            {data.user.profile.role} · {data.user.profile.organization} ·{' '}
            {data.user.profile.email} · {data.user.profile.phone}
          </p>
        </div>
        <div className='header-actions'>
          <button
            className='theme-toggle'
            type='button'
            onClick={() => setEditingProfile(true)}
          >
            Edit operator details
          </button>
          <button
            className='theme-toggle'
            type='button'
            onClick={() =>
              setTheme((current) => (current === 'light' ? 'dark' : 'light'))
            }
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
            aria-pressed={theme === 'dark'}
            title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          >
            <svg viewBox='0 0 24 24' aria-hidden='true'>
              {theme === 'light' ? (
                <path d='M20.1 15.4A8.4 8.4 0 0 1 8.6 3.9 8.5 8.5 0 1 0 20.1 15.4Z' />
              ) : (
                <>
                  <circle cx='12' cy='12' r='4' />
                  <path d='M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' />
                </>
              )}
            </svg>
            <span>{theme === 'light' ? 'Dark mode' : 'Light mode'}</span>
          </button>
          <button
            className='ghost-btn'
            onClick={async () => {
              await api('/logout', 'POST')
              setToken(null)
              setAuthed(false)
            }}
          >
            Log out
          </button>
        </div>
      </header>

      <div className='kpis'>
        <div>
          <big>{data.bookings.length}</big>bookings
        </div>
        <div>
          <big>{count('moved')}</big>re-allocated
        </div>
        <div>
          <big>{count('inspector')}</big>to the inspector
        </div>
        <div>
          <big>{data.insights?.buses_protected ?? '—'}</big>buses protected
        </div>
        <div>
          <big>{m ? m.bus_delay_minutes_lost : '—'}</big>min lost by buses
        </div>
        <div>
          <big>{sentCount}</big>SMS delivered ({confirmed} confirmed)
        </div>
      </div>
      <ActionSummary
        plan={plan}
        insights={data.insights}
        outbox={data.outbox}
        operator={data.user.profile}
        briefing={data.last_agent_briefing}
      />

      <nav>
        {tabs.map(([k, l]) => (
          <button
            key={k}
            className={tab === k ? 'on' : ''}
            onClick={() => setTab(k)}
          >
            {l}
          </button>
        ))}
      </nav>
      {msg && <div className='err'>{msg}</div>}

      {tab === 'workflow' && (
        <section className='card'>
          <h2>End-to-end agent workflow</h2>
          <div className='form'>
            <button onClick={run} disabled={busy}>
              {busy ? 'Agent working…' : '▶ Run agent'}
            </button>
            <label>
              <input
                type='checkbox'
                checked={useLlm}
                onChange={(e) => setUseLlm(e.target.checked)}
              />{' '}
              use LLM (slower on CPU)
            </label>
            <label>
              <input
                type='checkbox'
                checked={autoReply}
                onChange={(e) => setAutoReply(e.target.checked)}
              />{' '}
              simulate vendor replies
            </label>
            <button
              className='ghost-btn'
              onClick={() => act(() => api('/reset', 'POST'))}
            >
              Reset to scenario.json
            </button>
            {plan && (
              <>
                <button className='ghost-btn' onClick={exportDecisions}>
                  Export decisions CSV
                </button>
                <button
                  className='ghost-btn'
                  onClick={exportSms}
                  disabled={!data.outbox.length}
                >
                  Export SMS log CSV
                </button>
              </>
            )}
          </div>
          <Workflow
            steps={steps}
            shown={shown ?? steps.length}
            running={busy}
          />
          {m && (
            <div className='metrics'>
              <div>
                <big>{m.bus_delay_minutes_lost} min</big>lost by buses{' '}
                <span
                  className={'badge ' + (m.zero_delay_validated ? 'ok' : 'bad')}
                >
                  {m.zero_delay_validated
                    ? '✓ zero delay validated'
                    : 'not zero'}
                </span>
              </div>
              <div>
                <big>{m.bus_delay_saved_min} min</big>bus delay avoided
              </div>
              <div>
                <big>{m.circling_km_avoided} km</big>circling avoided{' '}
                <small>
                  ({m.instructions_issued}/{m.displaced_vendors} displaced
                  vendors instructed)
                </small>
              </div>
              <small>{m.assumption}</small>
            </div>
          )}
          {data.insights && <Insights ins={data.insights} />}
          {plan && (
            <>
              <h3>Clash detector</h3>
              {plan.clashes.length === 0 ? (
                <p className='sub'>No clashes detected.</p>
              ) : (
                plan.clashes.map((c, i) => (
                  <div key={i} className={'clash ' + c.severity}>
                    <b>{CLASH_LABEL[c.type]}</b> {c.text}
                  </div>
                ))
              )}
              <h3>Bus delay without vs with the agent</h3>
              <DelayBars buses={plan.buses} />
              <h3>Decisions</h3>
              <table>
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>Vehicle</th>
                    <th>Was</th>
                    <th>Now</th>
                    <th>Action</th>
                    <th>Why (rulebook)</th>
                    <th>Instruction</th>
                    <th>km</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.actions.map((a) => (
                    <tr key={a.id} className={a.status}>
                      <td>
                        <span className='dpic'>
                          <Pic label={a.vendor} size={20} />
                          {a.vendor}
                        </span>
                      </td>
                      <td>{a.vehicle_type}</td>
                      <td>
                        {a.old_slot} {a.old_start}
                      </td>
                      <td>
                        {a.status === 'inspector' ? (
                          <b className='insp'>{INSPECTOR}</b>
                        ) : (
                          `${a.slot} ${a.new_start}`
                        )}
                      </td>
                      <td>{a.action.replace(/_/g, ' ')}</td>
                      <td>
                        {a.reasons
                          .map(
                            (r) =>
                              `${r.rule === 'none' || r.rule === 'data' ? '' : r.rule + ': '}${r.text}`,
                          )
                          .join(' | ') || 'OK: compliant'}
                      </td>
                      <td>{a.reroute || '—'}</td>
                      <td>{a.circling_km_avoided || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>Buses</h3>
              {plan.buses.map((b, i) => (
                <div key={i} className={'bus ' + b.bay}>
                  {b.bus} {b.arrives} to {b.destination}
                  {b.school_bus ? ' (school bus)' : ''} — bay {b.bay}
                  {b.blocked_by && ` (threat: ${b.blocked_by})`}
                  {b.reroute && ` → ${b.reroute}`}
                </div>
              ))}
            </>
          )}
        </section>
      )}

      {tab === 'plan' && (
        <section className='card'>
          <h2>
            6-hour curb plan{' '}
            <small>
              {data.plan_window.start}–{data.plan_window.end}
            </small>
          </h2>
          {plan ? (
            <>
              <div className='checks'>
                <span
                  className={
                    'badge ' + (plan.checks.lockup_free ? 'ok' : 'bad')
                  }
                >
                  {plan.checks.lockup_free
                    ? '✓ no curb lockup'
                    : '✗ lockup: ' + plan.checks.lockup_details.join(', ')}
                </span>
                <span
                  className={
                    'badge ' + (plan.checks.curb_boundary_ok ? 'ok' : 'bad')
                  }
                >
                  {plan.checks.curb_length_used_m}/{plan.checks.curb_length_m} m
                  curb boundary
                </span>
                <span
                  className={
                    'badge ' + (plan.checks.all_buses_served ? 'ok' : 'bad')
                  }
                >
                  {plan.checks.all_buses_served
                    ? '✓ every bus served'
                    : 'a bus has no bay'}
                </span>
              </div>
              <div className='sim'>
                <button
                  onClick={() => {
                    if (clock >= W.b) setNow(W.a)
                    setPlaying((p) => !p)
                  }}
                >
                  {playing ? '⏸ Pause' : '▶ Simulate'}
                </button>
                <input
                  type='range'
                  min={W.a}
                  max={W.b}
                  value={clock}
                  onChange={(e) => {
                    setPlaying(false)
                    setNow(+e.target.value)
                  }}
                />
                <b>{hhmm(clock)}</b>
              </div>
              <h3>Curfew state</h3>
              <CurfewStrip data={data} plan={plan} />
              <TrafficPanel traffic={data.traffic} />
              <CurfewAdmin data={data} act={act} />
              <h3>Timeline</h3>
              <Timeline data={data} plan={plan} now={clock} />
              <NowPanel data={data} plan={plan} now={clock} />
              <h3>
                Slot-by-slot occupancy grid <small>(15-minute cells)</small>
              </h3>
              <Grid plan={plan} now={clock} />
              <DwellRecorder data={data} act={act} />
            </>
          ) : (
            <p className='sub'>Run the agent to generate the plan.</p>
          )}
        </section>
      )}

      {tab === 'bookings' && (
        <Bookings data={data} refresh={refresh} setMsg={setMsg} run={run} />
      )}
      {tab === 'inspector' && (
        <InspectorPanel data={data} plan={plan} act={act} now={clock} />
      )}
      {tab === 'ingest' && <LiveIngestion data={data} gpsStatus={gpsStatus} />}
      {tab === 'guard' && <Guardrails data={data} />}
      {tab === 'sms' && <Outbox outbox={data.outbox} act={act} now={clock} />}
      {tab === 'log' && <AuditLog data={data} />}
      <div className='toast-stack' aria-live='polite' aria-atomic='false'>
        {toasts.map((toast) => (
          <div key={toast.id} className='toast'>
            <time>{toast.at}</time>
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  )
}
