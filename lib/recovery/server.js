/**
 * The offline recovery server.
 *
 * This runs as a plain Node process, deliberately outside DSH. That is the
 * whole point: when a plugin conflict stops DSH from starting, nothing inside
 * DSH can render a rescue UI, so the rescue lives in its own process that only
 * needs Node plus the profile directory.
 *
 * It binds to 127.0.0.1 by default. Profile edits are reachable over HTTP, so
 * exposing this on a network interface is opt-in through `--host`.
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { attempt, toErrorPayload } from '../core/errors.js'

/** Largest JSON body accepted, in bytes. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Read a JSON request body.
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body is too large')
      error.code = 'http/body-too-large'
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    const error = new Error('request body is not valid JSON')
    error.code = 'http/body-invalid'
    throw error
  }
}

/**
 * Minimal router: exact method + path matches, no path parameters. Keeping the
 * surface explicit means a typo cannot silently fall through to a mutating
 * handler.
 */
function createRouter() {
  /** @type {Map<string, (ctx: any) => Promise<unknown> | unknown>} */
  const routes = new Map()
  return {
    /**
     * @param {string} method
     * @param {string} path
     * @param {(ctx: { body: Record<string, unknown>, url: URL, request: import('node:http').IncomingMessage }) => Promise<unknown> | unknown} handler
     */
    add(method, path, handler) {
      routes.set(`${method} ${path}`, handler)
    },
    get(method, path) {
      return routes.get(`${method} ${path}`)
    },
    paths() {
      return [...routes.keys()]
    },
  }
}

/**
 * CSRF-shaped protection: every response carries a per-process token and every
 * mutating request must echo it. A page on another origin cannot read the token,
 * so it cannot drive a restore.
 */
function tokenGuard(token) {
  return (request) => {
    const header = request.headers['x-version-guard-token']
    return typeof header === 'string' && header === token
  }
}

/**
 * @typedef {object} RecoveryServerOptions
 * @property {(profileName: string | null) => any} serviceFor Resolve a profile name to a service.
 * @property {() => { name: string, dir: string, snapshotCount: number, summary: unknown, error: string | null }[]} listProfiles
 * @property {string} html The recovery page markup.
 * @property {string} [host]
 * @property {number} [port]
 * @property {boolean} [inDsh] Whether this handler is mounted inside DSH.
 * @property {string} [base] API mount prefix baked into the page (`''` standalone).
 * @property {(line: string) => void} [log]
 */

/**
 * Build the recovery HTTP handler.
 * @param {RecoveryServerOptions} options
 */
export function createRecoveryHandler(options) {
  const token = randomBytes(24).toString('hex')
  const isAuthorized = tokenGuard(token)
  const log = options.log ?? (() => {})
  const router = createRouter()

  /** Wrap a handler: JSON in, JSON out, errors as `{ ok:false, error }`. */
  const json = (handler) => async (ctx) => {
    const outcome = await attempt(() => handler(ctx))
    if (outcome.ok) return { status: 200, payload: { ok: true, value: outcome.value } }
    return { status: 200, payload: { ok: false, error: outcome.error } }
  }

  /** Mutating endpoints require the token. */
  const guarded = (handler) => json(async (ctx) => {
    if (!isAuthorized(ctx.request)) {
      const error = new Error('missing or invalid request token')
      error.code = 'http/unauthorized'
      throw error
    }
    return handler(ctx)
  })

  /**
   * Resolve the service for a request, defaulting to the only profile when the
   * caller does not name one — the common case in a single-profile install.
   */
  const resolve = (profileName) => {
    const name = typeof profileName === 'string' && profileName.length > 0 ? profileName : null
    const service = options.serviceFor(name)
    if (service === null || service === undefined) {
      const error = new Error(name === null ? 'no DSH profile could be found' : `unknown profile: ${name}`)
      error.code = 'profile/unknown'
      throw error
    }
    return service
  }

  router.add('GET', '/healthz', () => ({
    status: 200,
    payload: { ok: true, value: { inDsh: options.inDsh === true, pid: process.pid } },
  }))

  router.add('GET', '/api/bootstrap', json(() => ({
    token,
    inDsh: options.inDsh === true,
    pid: process.pid,
    node: process.versions.node,
    platform: process.platform,
    serverTime: new Date().toISOString(),
    profiles: options.listProfiles(),
  })))

  router.add('GET', '/api/status', json(({ url }) => {
    const service = resolve(url.searchParams.get('profile'))
    return { token, ...service.status() }
  }))

  router.add('GET', '/api/snapshots', json(({ url }) => {
    const service = resolve(url.searchParams.get('profile'))
    return service.list()
  }))

  router.add('GET', '/api/snapshot', json(({ url }) => {
    const service = resolve(url.searchParams.get('profile'))
    const id = url.searchParams.get('id') ?? ''
    const snapshot = service.read(id)
    if (snapshot === null) {
      const error = new Error(`snapshot ${id} is missing or corrupt`)
      error.code = 'snapshot/not-found'
      throw error
    }
    return snapshot
  }))

  router.add('GET', '/api/diff', json(({ url }) => {
    const service = resolve(url.searchParams.get('profile'))
    return service.diff(url.searchParams.get('id') ?? '')
  }))

  router.add('POST', '/api/snapshot', guarded(({ body }) => {
    const service = resolve(body.profile)
    return service.snapshot({ reason: 'manual', note: typeof body.note === 'string' ? body.note : undefined })
  }))

  router.add('POST', '/api/delete', guarded(({ body }) => {
    const service = resolve(body.profile)
    return service.delete(String(body.id ?? ''))
  }))

  router.add('POST', '/api/restore', guarded(({ body }) => {
    const service = resolve(body.profile)
    return service.restore(String(body.id ?? ''))
  }))

  router.add('POST', '/api/install', guarded(({ body }) => {
    const service = resolve(body.profile)
    return service.install({ timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined })
  }))

  router.add('POST', '/api/plugin/disable', guarded(({ body }) => {
    const service = resolve(body.profile)
    return service.disable(String(body.name ?? ''), { reason: 'disabled from the offline recovery page' })
  }))

  router.add('POST', '/api/plugin/enable', guarded(({ body }) => {
    const service = resolve(body.profile)
    return service.enable(String(body.name ?? ''), String(body.range ?? ''))
  }))

  router.add('POST', '/api/plugin/pin', guarded(({ body }) => {
    const service = resolve(body.profile)
    return service.pin(String(body.name ?? ''), String(body.version ?? ''), { reason: 'pinned from the offline recovery page' })
  }))

  router.add('POST', '/api/rescue', guarded(({ body }) => {
    const service = resolve(body.profile)
    return service.rescue({ dryRun: body.dryRun === true })
  }))

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  return async function handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    const method = request.method ?? 'GET'
    // The mount prefix is stripped once, here, so every route and the page
    // itself are written relative to the guard and work identically whether the
    // guard owns its own port or is mounted under DSH's web server.
    const base = typeof options.base === 'string' ? options.base.replace(/\/+$/, '') : ''
    const requestedPath = url.pathname
    let path = url.pathname
    if (base.length > 0) {
      if (path === base) path = '/'
      else if (path.startsWith(`${base}/`)) path = path.slice(base.length)
      else {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ ok: false, error: { code: 'http/not-found', message: `not a version-guard path: ${requestedPath}` } }))
        return
      }
    }

    // The page itself, plus a favicon stub so browsers stop asking.
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      // The page carries placeholders so one HTML string can be served by any
      // process: the token is per process and must never be baked in, and the
      // API base differs between the standalone server and the DSH mount.
      let page = options.html
      if (page.includes('__VG_TOKEN__')) page = page.replace('__VG_TOKEN__', token)
      if (page.includes('__VG_BASE__')) page = page.replace(/__VG_BASE__/g, base)
      response.end(page)
      return
    }
    if (method === 'GET' && path === '/favicon.ico') {
      response.writeHead(204)
      response.end()
      return
    }

    const route = router.get(method, path)
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: false, error: { code: 'http/not-found', message: `no route for ${method} ${requestedPath}` } }))
      return
    }

    try {
      const body = method === 'POST' ? await readJsonBody(request) : {}
      const result = await route({ body, url, request })
      response.writeHead(result.status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      response.end(JSON.stringify(result.payload))
    } catch (error) {
      const payload = { ok: false, error: toErrorPayload(error) }
      log(`request failed: ${method} ${requestedPath} -> ${payload.error.code}`)
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(payload))
    }
  }
}

/**
 * Start the standalone recovery server.
 * @param {RecoveryServerOptions & { port?: number, host?: string }} options
 * @returns {Promise<{ url: string, close: () => Promise<void>, port: number }>}
 */
export function startRecoveryServer(options) {
  const handler = createRecoveryHandler(options)
  const host = options.host ?? '127.0.0.1'
  const requestedPort = options.port ?? 3939
  const server = createServer((request, response) => {
    handler(request, response).catch((error) => {
      try {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: toErrorPayload(error) }))
      } catch { /* response already sent */ }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : requestedPort
      resolve({
        port,
        url: `http://${host}:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}
