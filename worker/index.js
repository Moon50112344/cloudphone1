/**
 * AetherDroid — Control Plane (Hono backend)
 * Phase 5: Persistence & Watchdog — global persistence layer, node health
 * simulation, lastSeen heartbeats, and consistent state for all reads.
 */

import { Hono } from 'hono'

const app = new Hono()

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
app.use('/api/*', async (c, next) => {
  await next()

  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type')
})

app.options('/api/*', (c) => c.text('', 204))

// ---------------------------------------------------------------------------
// Simulated persistence layer
// ---------------------------------------------------------------------------
const PERSIST_KEY = 'aetherdroid.state'

function loadPersisted() {
  try {
    if (!globalThis[PERSIST_KEY]) {
      globalThis[PERSIST_KEY] = {
        sessions: new Map(),
        packages: new Map(),
        createdAt: Date.now(),
      }
    }
  } catch (err) {
    console.error('[persistence] init failed:', err?.message ?? err)

    globalThis[PERSIST_KEY] = {
      sessions: new Map(),
      packages: new Map(),
      createdAt: Date.now(),
    }
  }

  return globalThis[PERSIST_KEY]
}

function db() {
  return loadPersisted()
}

const sessions = () => db().sessions
const packages = () => db().packages

const OS_VERSIONS = ['13', '12', '11']
const REGIONS = ['us-east', 'eu-west', 'ap-south']

function makeSession(overrides = {}) {
  const id =
    overrides.id ??
    `ad-${Math.random().toString(16).slice(2, 6)}`

  return {
    id,
    name:
      overrides.name ??
      `Cloud Phone ${id.slice(-4).toUpperCase()}`,
    status: 'booting',
    cpu: overrides.cpu ?? 2,
    ram: overrides.ram ?? 4,
    os:
      overrides.os ??
      OS_VERSIONS[
        Math.floor(Math.random() * OS_VERSIONS.length)
      ],
    region:
      overrides.region ??
      REGIONS[
        Math.floor(Math.random() * REGIONS.length)
      ],
    createdAt: new Date().toISOString(),
    bootedAt: null,
    lastSeen: new Date().toISOString(),
    uptimeSeconds: 0,
    pc: null,
    lastInputSeq: 0,
    installedApks: [],
    ...overrides,
  }
}

function getSession(id) {
  return id ? sessions().get(id) ?? null : null
}

function serializeSession(s) {
  if (!s) {
    console.warn(
      '[serializeSession] called with a null/undefined session'
    )
    return null
  }

  const bootedMs =
    s.bootedAt &&
    !Number.isNaN(new Date(s.bootedAt).getTime())
      ? new Date(s.bootedAt).getTime()
      : 0

  const uptime = bootedMs
    ? Math.max(
        0,
        Math.floor((Date.now() - bootedMs) / 1000)
      )
    : 0

  const h = Math.floor(uptime / 3600)
  const d = Math.floor(h / 24)

  return {
    ...s,
    pc: undefined,
    _touchAnchor: undefined,
    uptimeSeconds: uptime,
    vRuntime: `${d}d ${h % 24}h`,
  }
}

function seedPackages() {
  if (packages().size > 0) return

  const seed = [
    {
      id: 'apk-seed-chrome',
      name: 'Chrome',
      package: 'com.android.chrome',
      version: '120.0',
      size: '84.2 MB',
    },
    {
      id: 'apk-seed-vlc',
      name: 'Vlc',
      package: 'org.videolan.vlc',
      version: '3.5.1',
      size: '32.7 MB',
    },
  ]

  for (const p of seed) {
    packages().set(p.id, {
      ...p,
      status: 'pending',
      addedAt: new Date().toISOString(),
    })
  }
}

function touchSession(id) {
  const s = getSession(id)

  if (s) {
    s.lastSeen = new Date().toISOString()
  }

  return s
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------
const NODES = [
  {
    id: 'host-a',
    label: 'Host A · us-east',
    cores: 16,
  },
  {
    id: 'host-b',
    label: 'Host B · eu-west',
    cores: 12,
  },
  {
    id: 'host-c',
    label: 'Host C · ap-south',
    cores: 8,
  },
]

function nodeHealth(node, sessionsList) {
  const hosted = sessionsList.filter(
    (s) =>
      s.region === node.label.split('· ')[1] &&
      s.status === 'online'
  )

  const t = Date.now() / 1000

  const load = Math.min(
    0.95,
    Math.max(
      0.08,
      hosted.length * 0.22 +
        0.15 +
        Math.sin(t / 37 + node.cores) * 0.08
    )
  )

  const disk = Math.min(
    0.95,
    Math.max(
      0.2,
      0.35 +
        hosted.length * 0.1 +
        Math.cos(t / 53) * 0.05
    )
  )

  const net = Math.min(
    940,
    Math.max(
      20,
      Math.round(
        hosted.length * 180 +
          Math.abs(Math.sin(t / 11)) * 120
      )
    )
  )

  const healthy = load < 0.85 && disk < 0.9

  return {
    id: node.id,
    label: node.label,
    cores: node.cores,
    load,
    disk,
    netMbps: net,
    status: healthy ? 'healthy' : 'degraded',
    instances: hosted.length,
    lastPing: new Date().toISOString(),
  }
}

function sweepStaleSessions() {
  const now = Date.now()
  let removed = 0

  for (const [id, s] of sessions()) {
    const lastSeenMs = new Date(
      s.lastSeen ?? 0
    ).getTime()

    if (
      s.status === 'offline' &&
      lastSeenMs &&
      now - lastSeenMs > 24 * 3600 * 1000
    ) {
      sessions().delete(id)
      removed++
    }
  }

  if (removed) {
    console.log(
      `[watchdog] reaped ${removed} stale offline session(s)`
    )
  }
}

// ---------------------------------------------------------------------------
// API: /api/watchdog
// ---------------------------------------------------------------------------
app.get('/api/watchdog', (c) => {
  try {
    sweepStaleSessions()

    const list = Array.from(sessions().values())
    const nodes = NODES.map((n) =>
      nodeHealth(n, list)
    )

    const degraded = nodes.filter(
      (n) => n.status !== 'healthy'
    ).length

    return c.json({
      ok: true,
      overall:
        degraded === 0
          ? 'operational'
          : degraded === nodes.length
            ? 'down'
            : 'degraded',
      watchdogLastRun: new Date().toISOString(),
      uptimePct:
        degraded === 0
          ? '99.9'
          : degraded === nodes.length
            ? '0'
            : '98.2',
      nodes,
    })
  } catch (err) {
    console.error(
      '[api/watchdog] failed:',
      err?.message ?? err
    )

    return c.json(
      {
        ok: false,
        error: 'Watchdog probe failed',
      },
      500
    )
  }
})

// ---------------------------------------------------------------------------
// API: /api/apks
// ---------------------------------------------------------------------------
app.get('/api/apks', (c) => {
  seedPackages()

  const list = Array.from(
    packages().values()
  ).map((p) => ({ ...p }))

  return c.json({
    ok: true,
    apks: list,
  })
})

app.post('/api/apks', async (c) => {
  try {
    const body = await c.req
      .json()
      .catch(() => ({}))

    if (!body?.id || !body?.name) {
      return c.json(
        {
          ok: false,
          error: 'id and name required',
        },
        400
      )
    }

    const pkg = {
      id: String(body.id),
      name: String(body.name),
      package:
        body.package ??
        `com.aetherdroid.${String(body.name)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')}`,
      version: body.version ?? '1.0.0',
      size: body.size ?? '—',
      status: 'pending',
      addedAt: new Date().toISOString(),
    }

    packages().set(pkg.id, pkg)

    return c.json(
      {
        ok: true,
        apk: pkg,
      },
      201
    )
  } catch (err) {
    console.error(
      '[api/apks POST] failed:',
      err?.message ?? err
    )

    return c.json(
      {
        ok: false,
        error: 'Failed to register package',
      },
      500
    )
  }
})

// ---------------------------------------------------------------------------
// API: /api/install
// ---------------------------------------------------------------------------
app.post('/api/install', async (c) => {
  try {
    const body = await c.req.json()
    const { sessionId, apkId } = body ?? {}

    if (!sessionId || !apkId) {
      return c.json(
        {
          ok: false,
          error: 'sessionId and apkId required',
        },
        400
      )
    }

    const session = touchSession(sessionId)

    if (!session) {
      return c.json(
        {
          ok: false,
          error: 'Instance not found',
        },
        404
      )
    }

    if (session.status !== 'online') {
      return c.json(
        {
          ok: false,
          error: 'Instance not online',
        },
        409
      )
    }

    seedPackages()

    const pkg = packages().get(apkId)

    if (!pkg) {
      return c.json(
        {
          ok: false,
          error: 'Package not found',
        },
        404
      )
    }

    if (session.installedApks.includes(apkId)) {
      return c.json(
        {
          ok: false,
          error:
            'Package already installed on this instance',
        },
        409
      )
    }

    const fileName =
      `${pkg.name.toLowerCase().replace(/[^a-z0-9]/g, '')}` +
      `-v${pkg.version}.apk`

    const command =
      `pm install -r /data/local/tmp/${fileName}`

    const installDelayMs =
      2500 + Math.floor(Math.random() * 1500)

    session.installedApks.push(apkId)
    pkg.status = 'installed'

    console.log(
      `[adb:${sessionId}] $ adb shell ${command} ` +
      `(simulated ${installDelayMs}ms)`
    )

    return c.json({
      ok: true,
      sessionId,
      apkId,
      command,
      installDelayMs,
    })
  } catch (err) {
    console.error(
      '[api/install] failed:',
      err?.message ?? err
    )

    return c.json(
      {
        ok: false,
        error: 'Install failed',
      },
      500
    )
  }
})

// ---------------------------------------------------------------------------
// API: /api/instances
// ---------------------------------------------------------------------------
app.get('/api/instances', (c) => {
  try {
    const list = Array.from(
      sessions().values()
    )
      .map(serializeSession)
      .filter((s) => s !== null)

    return c.json({
      ok: true,
      instances: list,
    })
  } catch (err) {
    console.error(
      '[api/instances] failed:',
      err?.message ?? err
    )

    return c.json(
      {
        ok: false,
        error: 'Failed to load instances',
      },
      500
    )
  }
})

// ---------------------------------------------------------------------------
// API: /api/status
// ---------------------------------------------------------------------------
app.get('/api/status', (c) => {
  try {
    const id = c.req.query('id')

    if (id) {
      const session = getSession(id)

      if (!session) {
        return c.json(
          {
            ok: false,
            error: 'Instance not found',
          },
          404
        )
      }

      return c.json({
        ok: true,
        instance: serializeSession(session),
      })
    }

    const list = Array.from(
      sessions().values()
    )

    return c.json({
      ok: true,
      stats: {
        active: list.filter(
          (s) => s.status === 'online'
        ).length,

        vcpu: list.reduce(
          (n, s) =>
            n +
            (s.status === 'online'
              ? s.cpu
              : 0),
          0
        ),

        ram: list.reduce(
          (n, s) =>
            n +
            (s.status === 'online'
              ? s.ram
              : 0),
          0
        ),
      },
    })
  } catch (err) {
    console.error(
      '[api/status] failed:',
      err?.message ?? err
    )

    return c.json(
      {
        ok: false,
        error: 'Status request failed',
      },
      500
    )
  }
})

// ---------------------------------------------------------------------------
// API: /api/start
// ---------------------------------------------------------------------------
app.post('/api/start', async (c) => {
  try {
    const body = await c.req
      .json()
      .catch(() => ({}))

    const session = makeSession({
      name: body?.name,
      cpu:
        Number(body?.cpu) > 0
          ? Number(body.cpu)
          : 2,
      ram:
        Number(body?.ram) > 0
          ? Number(body.ram)
          : 4,
    })

    session.status = 'online'
    session.bootedAt =
      new Date().toISOString()
    session.lastSeen =
      new Date().toISOString()

    sessions().set(
      session.id,
      session
    )

    return c.json(
      {
        ok: true,
        instance:
          serializeSession(session),
      },
      201
    )
  } catch (err) {
    console.error(
      '[api/start] failed:',
      err?.message ?? err
    )

    return c.json(
      {
        ok: false,
        error:
          'Failed to provision instance',
      },
      500
    )
  }
})

// ---------------------------------------------------------------------------
// API: /api/power
// ---------------------------------------------------------------------------
app.post('/api/power', async (c) => {
  try {
    const body = await c.req.json()
    const { id, action } = body ?? {}

    if (
      !id ||
      !['start', 'stop', 'restart'].includes(
        action
      )
    ) {
      return c.json(
        {
          ok: false,
          error:
            'id and valid action required',
        },
        400
      )
    }

    let session = getSession(id)

    if (!session && action === 'start') {
      session = makeSession({ id })
      sessions().set(id, session)
    }

    if (!session) {
      return c.json(
        {
          ok: false,
          error: 'Instance not found',
        },
        404
      )
    }

    if (action === 'stop') {
      session.status = 'offline'
      session.bootedAt = null
      session.pc = null
    } else {
      session.status = 'online'
      session.bootedAt =
        new Date().toISOString()
      session.pc = null
    }

    session.lastSeen =
      new Date().toISOString()

    return c.json({
      ok: true,
      instance:
        serializeSession(session),
    })
  } catch (err) {
    console.error(
      '[api/power] failed:',
      err?.message ?? err
    )

    return c.json(
      {
        ok: false,
        error: 'Power action failed',
      },
      500
    )
  }
})

// ---------------------------------------------------------------------------
// API: /api/signal
// ---------------------------------------------------------------------------
app.post('/api/signal', async (c) => {
  try {
    const body = await c.req.json()
    const { sessionId, sdp, type } =
      body ?? {}

    if (!sessionId) {
      return c.json(
        {
          ok: false,
          error: 'sessionId is required',
        },
        400
      )
    }

    const session =
      touchSession(sessionId)

    if (!session) {
      return c.json(
        {
          ok: false,
          error: 'Instance not found',
        },
        404
      )
    }

    if (session.status !== 'online') {
      return c.json(
        {
          ok: false,
          error: 'Instance not online',
        },
        409
      )
    }

    session.pc = {
      type: type ?? 'offer',
      state: 'answered',
      updatedAt:
        new Date().toISOString(),
    }

    const mockAnswer = {
      type: 'answer',
      sdp:
        'v=0\r\n' +
        'o=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n' +
        's=-\r\n' +
        't=0 0\r\n' +
        'a=group:BUNDLE 0\r\n' +
        'a=ice-options:trickle\r\n' +
        'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' +
        'a=rtpmap:96 H264/90000\r\n' +
        'a=sendonly\r\n',
    }

    return c.json({
      ok: true,
      sessionId,
      answer: mockAnswer,
      iceServers: [
        {
          urls:
            'stun:stun.l.google.com:19302',
        },
      ],
    })
  } catch (err) {
    console.error(
      '[api/signal] failed:',
      err?.message ?? err
    )

    return c.json(
      {
        ok: false,
        error: 'Signaling failed',
      },
      500
    )
  }
})

// ---------------------------------------------------------------------------
// API: /api/input
// ---------------------------------------------------------------------------
const ANDROID_RESOLUTION = {
  width: 1080,
  height: 1920,
}

function clamp01(n) {
  const v = Number(n)

  if (!Number.isFinite(v)) {
    return 0
  }

  return Math.min(
    1,
    Math.max(0, v)
  )
}

function adbCoord(v, max) {
  return Math.round(
    clamp01(v) * max
  )
}

function translateTouch(session, body) {
  const { type, x, y } = body

  const X = adbCoord(
    x,
    ANDROID_RESOLUTION.width
  )

  const Y = adbCoord(
    y,
    ANDROID_RESOLUTION.height
  )

  if (type === 'down') {
    session._touchAnchor = {
      x: X,
      y: Y,
      ts: Date.now(),
    }

    return `input motionevent DOWN ${X} ${Y}`
  }

  if (type === 'move') {
    return `input motionevent MOVE ${X} ${Y}`
  }

  if (type === 'up') {
    const anchor =
      session._touchAnchor

    session._touchAnchor = null

    if (anchor) {
      const dist = Math.hypot(
        X - anchor.x,
        Y - anchor.y
      )

      if (dist < 20) {
        return `input tap ${X} ${Y}`
      }

      return (
        `input swipe ${anchor.x} ${anchor.y} ` +
        `${X} ${Y}`
      )
    }

    return `input tap ${X} ${Y}`
  }

  return null
}

function translateKey(body) {
  const KEYCODES = {
    back: 4,
    home: 3,
    recents: 187,
    power: 26,
  }

  const code =
    Number.isInteger(body?.keycode)
      ? body.keycode
      : KEYCODES[body?.key]

  if (!code) {
    return null
  }

  return `input keyevent ${code}`
}

app.post('/api/input', async (c) => {
  try {
    const body = await c.req.json()

    const {
      sessionId,
      kind,
      seq,
    } = body ?? {}

    if (
      !sessionId ||
      ![
        'touch',
        'key',
        'installation',
        'heartbeat',
      ].includes(kind)
    ) {
      return c.json(
        {
          ok: false,
          error:
            'sessionId and valid kind (touch|key|installation|heartbeat) required',
        },
        400
      )
    }

    const session =
      touchSession(sessionId)

    if (!session) {
      return c.json(
        {
          ok: false,
          error: 'Instance not found',
        },
        404
      )
    }

    if (session.status !== 'online') {
      return c.json(
        {
          ok: false,
          error: 'Instance not online',
        },
        409
      )
    }

    if (Number.isInteger(seq)) {
      if (
        seq <= session.lastInputSeq
      ) {
        return c.json(
          {
            ok: false,
            error:
              'Stale event dropped',
          },
          409
        )
      }

      session.lastInputSeq = seq
    }

    let command = null

    let processingMs =
      2 +
      Math.floor(
        Math.random() * 6
      )

    if (kind === 'heartbeat') {
      command =
        'echo keepalive ok'
    } else if (kind === 'touch') {
      command =
        translateTouch(
          session,
          body
        )
    } else if (kind === 'key') {
      command =
        translateKey(body)
    } else if (
      kind === 'installation'
    ) {
      const apkName =
        body?.apkName ?? 'app'

      command =
        `pm install -r /data/local/tmp/` +
        `${String(apkName).replace(
          /[^a-zA-Z0-9._-]/g,
          ''
        )}.apk`

      processingMs =
        2000 +
        Math.floor(
          Math.random() * 1500
        )

      session._pendingInstall = {
        apkName,
        startedAt: Date.now(),
      }
    }

    if (!command) {
      return c.json(
        {
          ok: false,
          error:
            'Unrecognized input payload',
        },
        400
      )
    }

    console.log(
      `[adb:${sessionId}] $ ${command} ` +
      `(simulated ${processingMs}ms)`
    )

    return c.json({
      ok: true,
      sessionId,
      command,
      processingMs,
    })
  } catch (err) {
    console.error(
      '[api/input] failed:',
      err?.message ?? err
    )

    return c.json(
      {
        ok: false,
        error: 'Input bridge failure',
      },
      500
    )
  }
})

// ---------------------------------------------------------------------------
// Static Assets / SPA fallback
//
// Cloudflare Workers Assets provides the ASSETS binding.
// Do NOT use Hono's serveStatic() here.
// ---------------------------------------------------------------------------
app.get('*', async (c) => {
  try {
    if (c.env?.ASSETS) {
      return await c.env.ASSETS.fetch(
        c.req.raw
      )
    }

    return c.text(
      'Static Assets binding is not configured.',
      500
    )
  } catch (err) {
    console.error(
      '[assets] failed:',
      err?.message ?? err
    )

    return c.text(
      'Failed to load application.',
      500
    )
  }
})

export default app
