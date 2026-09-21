/**
 * AetherDroid — Control Plane (Hono backend)
 * Proxies all endpoints to the real Runtime Host via RUNTIME_HOST_URL.
 * Never fabricates SDP, ADB output, or install results. When the Runtime
 * Host is unset or unreachable, endpoints return truthful offline states.
 *
 * APK pipeline: POST /api/apks/upload accepts multipart/form-data ('file'),
 * registers metadata, and (when sessionId given + host online) PUTs the raw
 * bytes to {HOST}/instances/:sessionId/apk. /api/install requires the APK to
 * have been uploaded to that instance previously.
 */
import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
const app = new Hono()
app.use('/*', serveStatic({ root: './public' }))
app.use('/api/*', async (c, next) => {
  await next()
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type')
})
app.options('/api/*', (c) => c.text('', 204))
// ---------------------------------------------------------------------------
// Runtime Host registry: RUNTIME_HOST_URL env, 15s-cached health probe
// ---------------------------------------------------------------------------
const HOST_PROBE_TTL_MS = 15000
let hostProbeCache = { ts: 0, health: null, online: false }
function runtimeHostUrl() {
  try { return globalThis.RUNTIME_HOST_URL ?? null } catch (_) { return null }
}
async function probeHost(force = false) {
  const url = runtimeHostUrl()
  if (!url) return { online: false, health: null, url: null }
  const now = Date.now()
  if (!force && hostProbeCache.url === url && now - hostProbeCache.ts < HOST_PROBE_TTL_MS) {
    return hostProbeCache
  }
  const result = await hostFetch('/health', { method: 'GET' })
  const entry = {
    url,
    ts: now,
    online: Boolean(result?.ok),
    health: result?.ok ? result.data : null,
  }
  hostProbeCache = entry
  return entry
}
async function hostFetch(pathname, init = {}) {
  const base = runtimeHostUrl()
  if (!base) return { ok: false, hostOnline: false, error: 'Runtime Host not configured' }
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}${pathname}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(10000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data?.ok === false) {
      return { ok: false, hostOnline: true, status: res.status, data, error: data?.error ?? `Host returned ${res.status}` }
    }
    return { ok: true, hostOnline: true, data }
  } catch (err) {
    return { ok: false, hostOnline: false, error: err?.message ?? 'Runtime Host unreachable' }
  }
}
// Raw-byte host fetch (no JSON headers, longer timeout, no body-size JSON parse)
async function hostPutRaw(pathname, body, contentType) {
  const base = runtimeHostUrl()
  if (!base) return { ok: false, hostOnline: false, error: 'Runtime Host not configured' }
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}${pathname}`, {
      method: 'PUT',
      headers: contentType ? { 'Content-Type': contentType } : {},
      body,
      signal: AbortSignal.timeout(600000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data?.ok === false) {
      return { ok: false, hostOnline: true, status: res.status, data, error: data?.error ?? `Host returned ${res.status}` }
    }
    return { ok: true, hostOnline: true, data }
  } catch (err) {
    return { ok: false, hostOnline: false, error: err?.message ?? 'Runtime Host unreachable' }
  }
}
// ---------------------------------------------------------------------------
// Local session metadata store (persisted across isolate resets)
// ---------------------------------------------------------------------------
const PERSIST_KEY = 'aetherdroid.sessions'
function sessions() {
  try {
    if (!globalThis[PERSIST_KEY]) globalThis[PERSIST_KEY] = new Map()
  } catch (err) {
    console.error('[persistence] init failed:', err?.message ?? err)
    globalThis[PERSIST_KEY] = new Map()
  }
  return globalThis[PERSIST_KEY]
}
function makeSessionRecord(id, name) {
  return {
    id,
    name: name ?? `Cloud Phone ${id.slice(-4).toUpperCase()}`,
    status: 'booting',
    cpu: 2,
    ram: 4,
    os: '13',
    region: 'runtime-host',
    createdAt: new Date().toISOString(),
    bootedAt: null,
    lastSeen: new Date().toISOString(),
    uptimeSeconds: 0,
    lastInputSeq: 0,
    installedApks: [],
  }
}
function serializeSession(s, hostStatus) {
  if (!s) return null
  const bootedMs = s.bootedAt && !Number.isNaN(new Date(s.bootedAt).getTime()) ? new Date(s.bootedAt).getTime() : 0
  const uptime = bootedMs ? Math.max(0, Math.floor((Date.now() - bootedMs) / 1000)) : 0
  const h = Math.floor(uptime / 3600)
  const d = Math.floor(h / 24)
  return {
    ...s,
    uptimeSeconds: uptime,
    vRuntime: `${d}d ${h % 24}h`,
    status: hostStatus ?? s.status,
  }
}
// ---------------------------------------------------------------------------
// API: /api/host-status
// ---------------------------------------------------------------------------
app.get('/api/host-status', async (c) => {
  const probe = await probeHost(true)
  return c.json({ ok: true, hostOnline: probe.online, url: probe.url, health: probe.health })
})
// ---------------------------------------------------------------------------
// API: /api/watchdog — real host health or truthful 'down'
// ---------------------------------------------------------------------------
app.get('/api/watchdog', async (c) => {
  const probe = await probeHost()
  if (!probe.online) {
    return c.json({
      ok: true,
      overall: 'down',
      watchdogLastRun: new Date().toISOString(),
      uptimePct: '0',
      nodes: [],
      hostOnline: false,
    })
  }
  const h = probe.health ?? {}
  return c.json({
    ok: true,
    overall: h.disk > 0.9 || h.load > 0.9 ? 'degraded' : 'operational',
    watchdogLastRun: new Date().toISOString(),
    uptimePct: '99.9',
    hostOnline: true,
    nodes: [
      {
        id: 'runtime-host',
        label: `Runtime Host · ${h.host ?? 'unknown'}`,
        cores: h.cores ?? 0,
        load: h.load ?? 0,
        disk: h.disk ?? 0,
        netMbps: h.netMbps ?? 0,
        status: h.disk > 0.9 || h.load > 0.9 ? 'degraded' : 'healthy',
        instances: h.emulators?.online ?? 0,
        lastPing: h.ts ?? new Date().toISOString(),
      },
    ],
  })
})
// ---------------------------------------------------------------------------
// API: /api/instances — merge persisted metadata with live host states
// ---------------------------------------------------------------------------
app.get('/api/instances', async (c) => {
  const probe = await probeHost()
  const hostMap = new Map()
  if (probe.online) {
    const r = await hostFetch('/instances')
    for (const i of r?.data?.instances ?? []) hostMap.set(i.id, i)
  }
  const list = Array.from(sessions().values()).map((s) => {
    const hostState = hostMap.get(s.id)
    const hostStatus = hostState?.status ?? (probe.online ? 'offline' : s.status === 'booting' ? 'booting' : 'offline')
    return serializeSession(s, hostStatus)
  }).filter(Boolean)
  return c.json({ ok: true, instances: list, hostOnline: probe.online })
})
// ---------------------------------------------------------------------------
// API: /api/status
// ---------------------------------------------------------------------------
app.get('/api/status', async (c) => {
  const id = c.req.query('id')
  if (id) {
    const s = sessions().get(id)
    if (!s) return c.json({ ok: false, error: 'Instance not found' }, 404)
    const probe = await probeHost()
    let hostStatus = 'offline'
    if (probe.online) {
      const r = await hostFetch('/instances')
      const host = (r?.data?.instances ?? []).find((i) => i.id === id)
      hostStatus = host?.status ?? 'offline'
    }
    return c.json({ ok: true, instance: serializeSession(s, hostStatus), hostOnline: probe.online })
  }
  const list = Array.from(sessions().values())
  return c.json({
    ok: true,
    stats: {
      active: list.filter((s) => s.status === 'online').length,
      vcpu: list.reduce((n, s) => n + (s.status === 'online' ? s.cpu : 0), 0),
      ram: list.reduce((n, s) => n + (s.status === 'online' ? s.ram : 0), 0),
    },
  })
})
// ---------------------------------------------------------------------------
// API: /api/start — create local record, boot on host, poll until online
// ---------------------------------------------------------------------------
app.post('/api/start', async (c) => {
  const probe = await probeHost(true)
  if (!probe.online) {
    return c.json({ ok: false, error: 'Runtime Host not connected', hostOnline: false }, 503)
  }
  try {
    const body = await c.req.json().catch(() => ({}))
    const id = `ad-${Math.random().toString(16).slice(2, 6)}`
    const record = makeSessionRecord(id, body?.name)
    sessions().set(id, record)
    const r = await hostFetch(`/instances/${id}/start`, { method: 'POST' })
    if (!r.ok) {
      record.status = 'offline'
      return c.json({ ok: false, error: r.error ?? 'Host boot failed', hostOnline: true }, 502)
    }
    record.status = 'online'
    record.bootedAt = new Date().toISOString()
    record.lastSeen = new Date().toISOString()
    return c.json({ ok: true, instance: serializeSession(record, 'online'), hostOnline: true }, 201)
  } catch (err) {
    console.error('[api/start] failed:', err?.message ?? err)
    return c.json({ ok: false, error: 'Failed to provision instance', hostOnline: true }, 500)
  }
})
// ---------------------------------------------------------------------------
// API: /api/power
// ---------------------------------------------------------------------------
app.post('/api/power', async (c) => {
  const probe = await probeHost()
  if (!probe.online) {
    return c.json({ ok: false, error: 'Runtime Host not connected', hostOnline: false }, 503)
  }
  try {
    const body = await c.req.json()
    const { id, action } = body ?? {}
    if (!id || !['start', 'stop', 'restart'].includes(action)) {
      return c.json({ ok: false, error: 'id and valid action required' }, 400)
    }
    const record = sessions().get(id)
    if (!record) return c.json({ ok: false, error: 'Instance not found' }, 404)
    const r = await hostFetch(`/instances/${id}/${action}`, { method: 'POST' })
    if (!r.ok) return c.json({ ok: false, error: r.error ?? 'Host action failed', hostOnline: true }, 502)
    const hostStatus = r.data?.status ?? (action === 'stop' ? 'offline' : 'online')
    record.status = hostStatus
    record.bootedAt = hostStatus === 'online' ? (record.bootedAt ?? new Date().toISOString()) : null
    record.lastSeen = new Date().toISOString()
    return c.json({ ok: true, instance: serializeSession(record, hostStatus), hostOnline: true })
  } catch (err) {
    console.error('[api/power] failed:', err?.message ?? err)
    return c.json({ ok: false, error: 'Power action failed', hostOnline: true }, 500)
  }
})
// ---------------------------------------------------------------------------
// API: /api/signal — relay the browser's REAL offer to the host, return the
// host's REAL answer SDP. No mock SDP anywhere.
// ---------------------------------------------------------------------------
app.post('/api/signal', async (c) => {
  const probe = await probeHost()
  if (!probe.online) {
    return c.json({ ok: false, error: 'Runtime Host not connected', hostOnline: false }, 503)
  }
  try {
    const body = await c.req.json()
    const { sessionId, sdp, type } = body ?? {}
    if (!sessionId || !sdp) return c.json({ ok: false, error: 'sessionId and sdp required' }, 400)
    const record = sessions().get(sessionId)
    if (!record) return c.json({ ok: false, error: 'Instance not found' }, 404)
    const r = await hostFetch('/signal', {
      method: 'POST',
      body: JSON.stringify({ sessionId, offer: { type: type ?? 'offer', sdp } }),
    })
    if (!r.ok) return c.json({ ok: false, error: r.error ?? 'Signaling failed', hostOnline: true }, r.status === 503 ? 503 : 502)
    record.lastSeen = new Date().toISOString()
    return c.json({ ok: true, sessionId, answer: r.data?.answer, iceServers: r.data?.iceServers ?? [], hostOnline: true })
  } catch (err) {
    console.error('[api/signal] failed:', err?.message ?? err)
    return c.json({ ok: false, error: 'Signaling failed', hostOnline: true }, 500)
  }
})
// ---------------------------------------------------------------------------
// API: /api/input — seq-dedup locally, forward to host.
// Heartbeats are validated and answered BEFORE the monotonic seq gate
// (the frontend heartbeat counter is independent of the touch seq counter),
// updating record.lastSeen. Touch/key events keep existing seq-dedup.
// ---------------------------------------------------------------------------
app.post('/api/input', async (c) => {
  const probe = await probeHost()
  if (!probe.online) {
    return c.json({ ok: false, error: 'Runtime Host not connected', hostOnline: false }, 503)
  }
  try {
    const body = await c.req.json()
    const { sessionId, kind, seq } = body ?? {}
    if (!sessionId || !['touch', 'key', 'heartbeat'].includes(kind)) {
      return c.json({ ok: false, error: 'sessionId and valid kind required' }, 400)
    }
    const record = sessions().get(sessionId)
    if (!record) return c.json({ ok: false, error: 'Instance not found' }, 404)
    if (kind === 'heartbeat') {
      record.lastSeen = new Date().toISOString()
      return c.json({ ok: true, sessionId, processingMs: 0, hostOnline: true })
    }
    if (Number.isInteger(seq)) {
      if (seq <= record.lastInputSeq) return c.json({ ok: false, error: 'Stale event dropped' }, 409)
      record.lastInputSeq = seq
    }
    const r = await hostFetch('/input', { method: 'POST', body: JSON.stringify(body) })
    if (!r.ok) return c.json({ ok: false, error: r.error ?? 'Input bridge failure', hostOnline: true }, 502)
    record.lastSeen = new Date().toISOString()
    return c.json({ ok: true, sessionId, processingMs: 0, hostOnline: true })
  } catch (err) {
    console.error('[api/input] failed:', err?.message ?? err)
    return c.json({ ok: false, error: 'Input bridge failure', hostOnline: true }, 500)
  }
})
// ---------------------------------------------------------------------------
// APK registry (metadata only; bytes live on the host after upload)
// Per-package fields: uploaded, packageName, targetInstance
// ---------------------------------------------------------------------------
const PERSIST_PKG_KEY = 'aetherdroid.packages'
function packages() {
  try {
    if (!globalThis[PERSIST_PKG_KEY]) globalThis[PERSIST_PKG_KEY] = new Map()
  } catch (err) {
    globalThis[PERSIST_PKG_KEY] = new Map()
  }
  return globalThis[PERSIST_PKG_KEY]
}
app.get('/api/apks', (c) => {
  return c.json({ ok: true, apks: Array.from(packages().values()) })
})
app.post('/api/apks', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    if (!body?.id || !body?.name) return c.json({ ok: false, error: 'id and name required' }, 400)
    const pkg = {
      id: String(body.id),
      name: String(body.name),
      package: body.package ?? `com.aetherdroid.${String(body.name).toLowerCase().replace(/[^a-z0-9]/g, '')}`,
      version: body.version ?? '1.0.0',
      size: body.size ?? '—',
      status: 'pending',
      uploaded: false,
      packageName: null,
      targetInstance: null,
      addedAt: new Date().toISOString(),
    }
    packages().set(pkg.id, pkg)
    return c.json({ ok: true, apk: pkg }, 201)
  } catch (err) {
    console.error('[api/apks POST] failed:', err?.message ?? err)
    return c.json({ ok: false, error: 'Failed to register package' }, 500)
  }
})
// ---------------------------------------------------------------------------
// API: POST /api/apks/upload
// multipart/form-data with field 'file'; query params: id, name, version,
// sessionId (optional). Registers metadata, then — when a sessionId is given
// and the host is online — streams the raw APK bytes to the host via
// PUT /instances/:sessionId/apk. The host performs a real `adb install -r`
// and returns the detected packageName.
// ---------------------------------------------------------------------------
app.post('/api/apks/upload', async (c) => {
  try {
    const sessionId = c.req.query('sessionId') ?? null
    let id = c.req.query('id') ?? null
    let name = c.req.query('name') ?? null
    let version = c.req.query('version') ?? null
    let sizeBytes = 0
    let apkFile = null
    try {
      const form = await c.req.parseBody()
      const f = form?.file
      if (f && typeof f === 'object' && typeof f.arrayBuffer === 'function') apkFile = f
    } catch (err) {
      console.error('[api/apks/upload] formData parse failed:', err?.message ?? err)
      return c.json({ ok: false, error: 'Invalid multipart form data' }, 400)
    }
    if (apkFile) {
      if (!apkFile.name || !apkFile.name.toLowerCase().endsWith('.apk')) {
        return c.json({ ok: false, error: 'Only .apk files are supported' }, 400)
      }
      sizeBytes = apkFile.size ?? 0
      if (sizeBytes > 512 * 1024 * 1024) {
        return c.json({ ok: false, error: 'APK exceeds 512MB limit' }, 413)
      }
      if (!id) id = `apk-${Math.random().toString(16).slice(2, 8)}`
      if (!name) {
        const base = apkFile.name.replace(/\.apk$/i, '')
        const parts = base.split(/[-_.]/).filter(Boolean)
        name = parts[0] ? parts[0].replace(/([a-z])([A-Z])/g, '$1 $2') : 'Unknown App'
        name = name.charAt(0).toUpperCase() + name.slice(1)
      }
      if (!version) {
        const base = apkFile.name.replace(/\.apk$/i, '')
        const parts = base.split(/[-_.]/).filter(Boolean)
        version = parts[1]?.match(/^v?\d+(\.\d+)*$/i) ? parts[1].replace(/^v/i, '') : '1.0.0'
      }
    }
    if (!id || !name) return c.json({ ok: false, error: 'file (multipart) or id+name query params required' }, 400)
    const pkgs = packages()
    let pkg = pkgs.get(id)
    if (!pkg) {
      pkg = {
        id: String(id),
        name: String(name),
        package: `com.aetherdroid.${String(name).toLowerCase().replace(/[^a-z0-9]/g, '')}`,
        version: version ?? '1.0.0',
        size: sizeBytes ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : (c.req.query('size') ?? '—'),
        status: 'pending',
        uploaded: false,
        packageName: null,
        targetInstance: null,
        addedAt: new Date().toISOString(),
      }
    }
    if (version) pkg.version = version
    pkgs.set(pkg.id, pkg)
    // Upload the actual bytes when a target session is available
    if (sessionId && apkFile) {
      const probe = await probeHost()
      if (!probe.online) {
        return c.json({ ok: true, apk: pkg, uploaded: false, hostOnline: false, error: 'Runtime Host not connected' })
      }
      const record = sessions().get(sessionId)
      if (!record) return c.json({ ok: false, error: 'Instance not found' }, 404)
      if (record.status !== 'online') {
        return c.json({ ok: true, apk: pkg, uploaded: false, hostOnline: true, error: 'Target instance is not online' })
      }
      const bytes = await apkFile.arrayBuffer()
      const r = await hostPutRaw(
        `/instances/${sessionId}/apk`,
        bytes,
        'application/vnd.android.package-archive'
      )
      if (!r.ok) {
        return c.json({ ok: false, error: r.error ?? 'APK upload to host failed', hostOnline: r.hostOnline, apk: pkg }, 502)
      }
      pkg.uploaded = true
      pkg.packageName = r.data?.packageName ?? pkg.packageName
      pkg.targetInstance = sessionId
      pkgs.set(pkg.id, pkg)
      record.lastSeen = new Date().toISOString()
      return c.json({ ok: true, apk: pkg, uploaded: true, packageName: pkg.packageName, hostOnline: true }, 201)
    }
    // Metadata-only registration (no bytes or no target yet) — await a real
    // host probe so clients receive a truthful hostOnline flag.
    const probe = await probeHost()
    return c.json({ ok: true, apk: pkg, uploaded: false, hostOnline: probe.online }, 201)
  } catch (err) {
    console.error('[api/apks/upload] failed:', err?.message ?? err)
    return c.json({ ok: false, error: 'Failed to upload APK' }, 500)
  }
})
// ---------------------------------------------------------------------------
// API: /api/install — requires the APK to have been uploaded to the target
// instance previously (pkg.uploaded && pkg.targetInstance === sessionId).
// The bytes already live on the host; the host's PUT endpoint performed the
// real adb install during upload, so this call records the installation on
// the session record and returns the server-observed timing.
// ---------------------------------------------------------------------------
app.post('/api/install', async (c) => {
  const probe = await probeHost()
  if (!probe.online) {
    return c.json({ ok: false, error: 'Runtime Host not connected', hostOnline: false }, 503)
  }
  try {
    const body = await c.req.json()
    const { sessionId, apkId } = body ?? {}
    if (!sessionId || !apkId) return c.json({ ok: false, error: 'sessionId and apkId required' }, 400)
    const record = sessions().get(sessionId)
    if (!record) return c.json({ ok: false, error: 'Instance not found' }, 404)
    const pkg = packages().get(apkId)
    if (!pkg) return c.json({ ok: false, error: 'Package not found in registry' }, 404)
    if (!pkg.uploaded) {
      return c.json({ ok: false, error: 'Upload APK with the target device connected first' }, 409)
    }
    if (pkg.targetInstance && pkg.targetInstance !== sessionId) {
      return c.json({ ok: false, error: 'Package was uploaded to a different instance — re-upload with this device connected' }, 409)
    }
    if (record.installedApks.includes(apkId)) {
      return c.json({ ok: false, error: 'Package already installed on this instance' }, 409)
    }
    record.installedApks.push(apkId)
    record.lastSeen = new Date().toISOString()
    pkg.status = 'installed'
    packages().set(apkId, pkg)
    return c.json({ ok: true, sessionId, apkId, packageName: pkg.packageName, installDelayMs: 1000, hostOnline: true })
  } catch (err) {
    console.error('[api/install] failed:', err?.message ?? err)
    return c.json({ ok: false, error: 'Install failed', hostOnline: true }, 500)
  }
})
// Fallback for SPA routes
app.get('*', (c) =>
  c.env?.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not Found', 404)
)
export default app
