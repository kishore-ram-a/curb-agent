let token = localStorage.getItem('token')
const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')
export const setToken = (t) => {
  token = t
  t ? localStorage.setItem('token', t) : localStorage.removeItem('token')
}
export const hasToken = () => !!token

export function websocketUrl(path) {
  const configuredWs = (import.meta.env.VITE_WS_BASE_URL || '').replace(
    /\/+$/,
    '',
  )
  if (configuredWs) return configuredWs + path
  if (apiBase)
    return apiBase.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + path
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}${path}`
}

export async function api(path, method = 'GET', body) {
  const r = await fetch(apiBase + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const d = await r.json().catch(() => ({}))
  if (r.status === 401 && path !== '/login') {
    setToken(null)
    window.location.reload()
  }
  if (!r.ok)
    throw new Error(typeof d.detail === 'string' ? d.detail : 'Request failed')
  return d
}
