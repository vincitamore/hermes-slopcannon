// SLOPCANNON for Hermes Desktop: the desktop half of the `slopcannon` package.
//
// Plain ESM, loaded uncompiled by the Desktop disk-plugin door. Only
// `@hermes/plugin-sdk` and `react` are imported. The SDK is read through a
// namespace import so a name an older Desktop does not export degrades to
// `undefined` (feature-detected below) instead of failing the module load.
//
// Contributions:
//   - route `/slopcannon` + sidebar nav row `SLOPCANNON` (the studio page)
//   - status bar item (right cluster): credits and running renders
//   - palette: Open studio, Copy sign-in command, Refresh
//   - transcript directive `::slopcannon-film{id="<production id>"}`
//   - tool media renderer for this package's own tools' MEDIA files
//
// Backend: dashboard/plugin_api.py, reached with ctx.rest('/...'). Live updates
// arrive as `plugin.slopcannon.*` gateway events; React Query polling is the
// fallback (5 s while anything renders, 30 s otherwise).

import * as sdk from '@hermes/plugin-sdk'
import { Component, createElement as h, Fragment, useEffect, useMemo, useState } from 'react'

const ID = 'slopcannon'
const ROUTE = '/slopcannon'
const TOP_UP_URL = 'https://slop.cc/account#buy-credits'
// Sign-in belongs to Hermes and runs in a terminal; the studio only shows the command.
const SIGN_IN_COMMAND = 'hermes auth add slopcannon:slop'
const PRODUCTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const FAST_POLL_MS = 5_000
const SLOW_POLL_MS = 30_000
const SESSION_MEMORY_LIMIT = 60

const {
  host,
  useQuery,
  useValue,
  queryClient,
  atom,
  Button,
  Badge,
  Codicon,
  Tip,
  ConfirmDialog,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  PALETTE_AREA
} = sdk

const MEDIA_TOOLS = ['slopcannon_wait', 'slopcannon_download', 'slopcannon_produce', 'slopcannon_production_status']
const PRODUCTION_TOOLS = new Set(['slopcannon_produce', 'slopcannon_production_status'])

// -----------------------------------------------------------------------------
// Module state (reset on every register; a hot reload evaluates a fresh module)

let CTX = null
const $selected = atom(null)
const lastSeenNeeds = new Map()
const savers = new Map()

// -----------------------------------------------------------------------------
// Defensive readers

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const obj = v => (isObj(v) ? v : {})
const str = v => (typeof v === 'string' && v.trim() !== '' ? v : null)
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const int = v => (num(v) === null ? null : Math.round(v))
const arr = v => (Array.isArray(v) ? v : [])

function parseMaybeJson(value) {
  if (typeof value === 'string') {
    const head = value.trimStart()[0]
    if ((head === '{' || head === '[') && value.length < 4_000_000) {
      try {
        return JSON.parse(value)
      } catch {
        return null
      }
    }
    return null
  }
  return value
}

function fmtCredits(n) {
  if (n === null || n === undefined) return '-'
  try {
    return Number(n).toLocaleString()
  } catch {
    return String(n)
  }
}

function fmtClock(ms) {
  if (num(ms) === null) return null
  const total = Math.max(0, Math.round(ms / 100) / 10)
  const m = Math.floor(total / 60)
  const s = total - m * 60
  const whole = Number.isInteger(s)
  const sec = whole ? String(s).padStart(2, '0') : s.toFixed(1).padStart(4, '0')
  return `${m}:${sec}`
}

function fmtRange(startMs, endMs) {
  const a = fmtClock(startMs)
  const b = fmtClock(endMs)
  if (a && b) return `${a}-${b}`
  return a || b || null
}

function fmtBytes(n) {
  if (num(n) === null) return null
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtWhen(ms) {
  if (num(ms) === null || ms <= 0) return null
  try {
    if (typeof sdk.relativeTime === 'function') return sdk.relativeTime(ms)
  } catch {
    // fall through
  }
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return null
  }
}

function fmtWhenAbsolute(ms) {
  if (num(ms) === null || ms <= 0) return ''
  try {
    if (sdk.fmtDateTime && typeof sdk.fmtDateTime.format === 'function') return sdk.fmtDateTime.format(new Date(ms))
    return new Date(ms).toLocaleString()
  } catch {
    return ''
  }
}

// Strip anything that could be a credential or a capability link from text we
// show (backend errors, driver log lines). Query strings carry signatures.
function redact(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\b(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, '$1?...')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ...')
    .replace(/\b(token|access_token|refresh_token|api[_-]?key|secret|signature|sig|code)=([^&\s"']+)/gi, '$1=...')
    .replace(/\bsc_(?:live|test|pat)_[A-Za-z0-9]{8,}/g, 'sc_...')
}

function samePath(a, b) {
  if (!a || !b) return false
  const norm = p => {
    let s = String(p).replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/')
    if (/^[a-z]:\//i.test(s) || s.startsWith('//')) s = s.toLowerCase()
    return s
  }
  return norm(a) === norm(b)
}

function baseName(p) {
  if (!p) return ''
  const parts = String(p).split(/[\\/]/)
  return parts[parts.length - 1] || String(p)
}

// -----------------------------------------------------------------------------
// Normalizers for the backend contract

function normStatus(raw) {
  const o = obj(raw)
  const c = isObj(o.credits) ? o.credits : null
  const s = obj(o.service)
  return {
    connected: o.connected === true,
    via: str(o.via),
    expiresAt: num(o.expiresAt),
    credits: c ? { available: int(c.available), reserved: int(c.reserved), scope: str(c.scope) } : null,
    service: {
      status: str(s.status),
      submissionReady: typeof s.submissionReady === 'boolean' ? s.submissionReady : null
    },
    error: str(o.error),
    signInCommand: str(obj(o.signIn).command) || SIGN_IN_COMMAND,
    // Whole productions run on the backend's Node.js; `ok: false` means none can start.
    node: isObj(o.node) ? { ok: o.node.ok !== false, message: str(o.node.message) } : null
  }
}

const SCENE_STATUSES = new Set(['unsubmitted', 'quoted', 'queued', 'running', 'succeeded', 'failed', 'uncertain'])
const STATES = new Set(['idle', 'running', 'needs', 'done', 'error'])

function normClip(raw) {
  const o = obj(raw)
  const path = str(o.path)
  return path ? { path, name: str(o.name) || baseName(path) } : null
}

function normIssue(raw) {
  const o = obj(raw)
  return {
    kind: str(o.kind),
    character: str(o.character),
    second: num(o.second),
    description: str(o.description)
  }
}

function normCheck(raw) {
  if (!isObj(raw)) return null
  const verdict = ['pass', 'fail', 'unchecked'].includes(raw.verdict) ? raw.verdict : 'unchecked'
  const error = isObj(raw.error) && str(raw.error.message) ? { message: raw.error.message, retryable: raw.error.retryable === true } : null
  return { verdict, issues: arr(raw.issues).map(normIssue), error }
}

function normScene(raw, i) {
  if (!isObj(raw) || !str(raw.id)) return null
  const o = raw
  const id = raw.id
  return {
    id,
    index: int(o.index) ?? i,
    startMs: num(o.startMs),
    endMs: num(o.endMs),
    beat: str(o.beat),
    status: SCENE_STATUSES.has(o.status) ? o.status : 'unsubmitted',
    quoteCredits: int(o.quoteCredits),
    generationId: str(o.generationId),
    clip: normClip(o.clip),
    check: normCheck(o.check)
  }
}

function countRows(rows) {
  return {
    total: rows.length,
    downloaded: rows.filter(r => r.clip).length,
    running: rows.filter(r => r.status === 'running' || r.status === 'queued').length,
    failed: rows.filter(r => r.status === 'failed').length
  }
}

function normProduction(raw) {
  const o = obj(raw)
  const id = str(o.id)
  if (!id) return null
  let rows = null
  let counts
  if (Array.isArray(o.scenes)) {
    rows = o.scenes.map(normScene).filter(Boolean)
    counts = countRows(rows)
  } else {
    const sc = obj(o.scenes)
    counts = {
      total: int(sc.total) ?? 0,
      downloaded: int(sc.downloaded) ?? 0,
      running: int(sc.running) ?? 0,
      failed: int(sc.failed) ?? 0
    }
  }
  const spend = obj(o.spend)
  return {
    id,
    title: str(o.title) || id,
    state: STATES.has(o.state) ? o.state : 'idle',
    needs: str(o.needs),
    message: str(o.message),
    updatedAt: num(o.updatedAt),
    aspectRatio: str(o.aspectRatio),
    projectId: str(o.projectId),
    sessionId: str(o.sessionId),
    counts,
    rows,
    spend: { approvedCredits: int(spend.approvedCredits), committedCredits: int(spend.committedCredits) },
    master: normClip(o.master),
    assembly: o.assembly && typeof o.assembly === 'object' && str(o.assembly.id) ? { id: str(o.assembly.id), status: str(o.assembly.status) } : null,
    needsDetail: isObj(o.needsDetail) ? o.needsDetail : null,
    log: arr(o.log).filter(l => typeof l === 'string')
  }
}

// -----------------------------------------------------------------------------
// Backend access

function api(path, opts) {
  if (!CTX || typeof CTX.rest !== 'function') return Promise.reject(new Error('SLOPCANNON plugin is not loaded'))
  return CTX.rest(path, opts)
}

function useScopeKey() {
  let profile = ''
  try {
    profile = useValue(host.state.profile) || ''
  } catch {
    profile = ''
  }
  return profile
}

const keys = {
  all: ['slopcannon'],
  status: scope => ['slopcannon', scope, 'status'],
  list: scope => ['slopcannon', scope, 'productions'],
  detail: (scope, id) => ['slopcannon', scope, 'production', id]
}

function invalidateAll() {
  try {
    queryClient.invalidateQueries({ queryKey: keys.all })
  } catch {
    // no client: nothing cached
  }
}

function useStatus() {
  const scope = useScopeKey()
  return useQuery({
    queryKey: keys.status(scope),
    queryFn: async () => normStatus(await api('/status')),
    refetchInterval: SLOW_POLL_MS,
    staleTime: 4_000,
    retry: 1
  })
}

function useProductions() {
  const scope = useScopeKey()
  return useQuery({
    queryKey: keys.list(scope),
    queryFn: async () => {
      const raw = await api('/productions')
      const list = arr(obj(raw).productions).map(normProduction).filter(Boolean)
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      return list
    },
    refetchInterval: query => {
      const list = query && query.state ? query.state.data : null
      return Array.isArray(list) && list.some(p => p.state === 'running') ? FAST_POLL_MS : SLOW_POLL_MS
    },
    staleTime: 2_000,
    retry: 1
  })
}

function useProduction(id) {
  const scope = useScopeKey()
  return useQuery({
    queryKey: keys.detail(scope, id || ''),
    enabled: Boolean(id),
    queryFn: async () => {
      // Capture the save action alongside the read so it keeps this read's
      // connection/profile scope (SDK contract for captureGatewayFileDownload).
      let saver = null
      try {
        if (typeof sdk.captureGatewayFileDownload === 'function') saver = sdk.captureGatewayFileDownload()
      } catch {
        saver = null
      }
      const p = normProduction(await api(`/productions/${encodeURIComponent(id)}`))
      if (!p) throw new Error('Unexpected production record')
      if (saver) savers.set(p.id, saver)
      return p
    },
    refetchInterval: query => {
      const p = query && query.state ? query.state.data : null
      return p && p.state === 'running' ? FAST_POLL_MS : SLOW_POLL_MS
    },
    staleTime: 2_000,
    retry: (count, error) => count < 1 && !isNotFound(error)
  })
}

function isNotFound(error) {
  const text = String((error && (error.message || error.detail)) || error || '')
  return /\b404\b|not found/i.test(text)
}

function backendDownText(error) {
  if (isNotFound(error)) {
    return 'The SLOPCANNON backend is not loaded for this profile. Enable the slopcannon plugin for the agent (plugins.enabled) and restart the gateway.'
  }
  return 'The SLOPCANNON backend is not answering. It may be starting, or the gateway is restarting.'
}

// -----------------------------------------------------------------------------
// Sending decisions back to the agent

function rememberSession(productionId, sessionId) {
  if (!CTX || !productionId || !sessionId) return
  try {
    const map = obj(CTX.storage.get('sessions', {}))
    if (map[productionId] && map[productionId].id === sessionId) return
    map[productionId] = { id: sessionId, at: Date.now() }
    const entries = Object.entries(map)
    if (entries.length > SESSION_MEMORY_LIMIT) {
      entries.sort((a, b) => (obj(b[1]).at || 0) - (obj(a[1]).at || 0))
      CTX.storage.set('sessions', Object.fromEntries(entries.slice(0, SESSION_MEMORY_LIMIT)))
    } else {
      CTX.storage.set('sessions', map)
    }
  } catch {
    // storage is best effort
  }
}

function rememberedSession(productionId) {
  if (!CTX || !productionId) return null
  try {
    return str(obj(obj(CTX.storage.get('sessions', {}))[productionId]).id)
  } catch {
    return null
  }
}

function notify(kind, message) {
  try {
    host.notify({ kind, message })
  } catch {
    // no toast surface
  }
}

function trySubmit(sessionId, text) {
  try {
    return Boolean(host.composer && host.composer.submit(sessionId, text))
  } catch {
    return false
  }
}

async function copyFallback(text) {
  let copied = false
  try {
    copied = Boolean(CTX && (await CTX.os.writeClipboard(text)))
  } catch {
    copied = false
  }
  notify(
    'warning',
    copied
      ? 'No chat could take the message, so it is on your clipboard. Paste it into the chat with the agent.'
      : 'No chat could take the message. Open the chat with the agent and try again.'
  )
}

// From a transcript card: the card's own chat, fail closed (SDK contract).
function sendFromCard(sessionId, text) {
  const sent = trySubmit(sessionId === undefined ? null : sessionId, text)
  if (!sent) notify('warning', 'Open that chat to send this.')
  return sent
}

// From the studio page: the chat the production came from when known, else
// the composer the person is using; failing both, open the remembered chat
// and retry once; failing that, the clipboard.
async function sendFromStudio(production, text) {
  const target = (production && (production.sessionId || rememberedSession(production.id))) || null
  if (target && trySubmit(target, text)) return notify('success', 'Sent to the chat.')
  if (trySubmit(null, text)) return notify('success', 'Sent to the chat.')
  if (target && typeof host.openSession === 'function') {
    try {
      await host.openSession(target)
    } catch {
      return copyFallback(text)
    }
    const retry = () => {
      if (trySubmit(target, text) || trySubmit(null, text)) notify('success', 'Sent to the chat.')
      else void copyFallback(text)
    }
    if (CTX && typeof CTX.setTimeout === 'function') CTX.setTimeout(retry, 900)
    else retry()
    return undefined
  }
  return copyFallback(text)
}

function filmRef(p) {
  if (!p) return 'the film'
  return p.title && p.title !== p.id ? `"${p.title}" (production ${p.id})` : `production ${p.id}`
}

// -----------------------------------------------------------------------------
// Phases and needs

const PHASES = [
  { id: 'rights', label: 'Rights' },
  { id: 'approve', label: 'Quote and approve' },
  { id: 'first', label: 'First scene' },
  { id: 'render', label: 'Rendering' },
  { id: 'checks', label: 'Checks' },
  { id: 'assembly', label: 'Assembly' },
  { id: 'done', label: 'Done' }
]

function phaseOf(p) {
  if (!p) return 'rights'
  if (p.state === 'done') return 'done'
  switch (p.needs) {
    case 'rights':
      return 'rights'
    case 'approval':
    case 'budget':
      return 'approve'
    case 'first_scene_review':
      return 'first'
    case 'shot_review':
      return 'checks'
    default:
      break
  }
  const { total, downloaded } = p.counts
  if (!total) return 'rights'
  if (!downloaded) return p.spend.approvedCredits !== null ? 'first' : 'approve'
  if (downloaded < total) return 'render'
  // Once the driver has submitted the server assembly, checks are behind it: a scene the server never
  // checked keeps no verdict for good, so its missing verdict must not hold the stepper on Checks.
  if (p.assembly) return 'assembly'
  if (Array.isArray(p.rows) && p.rows.some(r => r.clip && (!r.check || r.check.verdict === 'unchecked'))) return 'checks'
  return 'assembly'
}

function phaseLabel(id) {
  const found = PHASES.find(x => x.id === id)
  return found ? found.label : id
}

const STATE_META = {
  idle: { label: 'Idle', variant: 'muted' },
  running: { label: 'Running', variant: 'default' },
  needs: { label: 'Needs you', variant: 'warn' },
  done: { label: 'Done', variant: 'success' },
  error: { label: 'Error', variant: 'destructive' }
}

const SCENE_META = {
  unsubmitted: { label: 'Not submitted', variant: 'muted' },
  quoted: { label: 'Quoted', variant: 'muted' },
  queued: { label: 'Queued', variant: 'outline' },
  running: { label: 'Rendering', variant: 'default' },
  succeeded: { label: 'Rendered', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
  uncertain: { label: 'Uncertain', variant: 'warn' }
}

function needsTotalCredits(p) {
  const d = obj(p && p.needsDetail)
  const total = int(d.totalCannonCredits)
  if (total !== null) return total
  const quotes = arr(d.quotes)
  if (quotes.length) {
    const sum = quotes.reduce((acc, q) => acc + (int(obj(q).amountUnits) || 0), 0)
    if (sum > 0) return sum
  }
  return p && p.spend ? p.spend.approvedCredits : null
}

// One description per need: what the person decides, and the single message
// the primary button sends.
function needsModel(p) {
  if (!p) return null
  const ref = filmRef(p)
  const d = obj(p.needsDetail)
  if (p.state === 'error') {
    return {
      tone: 'error',
      icon: 'error',
      headline: 'The production stopped with an error',
      body: p.message ? redact(p.message) : 'The driver reported an error and stopped.',
      primary: { label: 'Ask the agent to look into it', text: `${ref} stopped with an error. Look into it and tell me the options.` }
    }
  }
  switch (p.needs) {
    case 'rights': {
      const version = str(d.requiredVersion)
      return {
        tone: 'attention',
        icon: 'law',
        headline: 'Agree to the rights statement',
        body: `SLOPCANNON renders nothing until you confirm you hold the rights to the files below${version ? ` (statement ${version})` : ''}.`,
        primary: { label: 'I agree, continue', text: `I agree to the SLOPCANNON rights statement for these files; continue the film ${ref}.` }
      }
    }
    case 'approval': {
      const n = needsTotalCredits(p)
      const scenes = arr(d.quotes).length
      return {
        tone: 'attention',
        icon: 'credit-card',
        headline: 'Approve the quote',
        body: `${n !== null ? `${fmtCredits(n)} Cannon Credits` : 'The quoted credits'}${scenes ? ` for ${scenes} scene${scenes === 1 ? '' : 's'}` : ''}. Rendering waits for your approval.`,
        primary:
          n !== null
            ? { label: `Approve ${fmtCredits(n)} credits`, text: `Approve up to ${n} Cannon Credits for ${ref}.` }
            : { label: 'Approve the quote', text: `Approve the quoted Cannon Credits for ${ref}.` }
      }
    }
    case 'budget': {
      const limit = int(d.limitCredits)
      const committed = int(d.committedCredits)
      const pending = int(d.pendingCredits)
      const exposure = int(d.exposureCredits)
      const parts = []
      if (limit !== null) parts.push(`limit ${fmtCredits(limit)}`)
      if (committed !== null) parts.push(`committed ${fmtCredits(committed)}`)
      if (pending !== null) parts.push(`pending ${fmtCredits(pending)}`)
      return {
        tone: 'attention',
        icon: 'credit-card',
        headline: 'The approved budget is used up',
        body: `${parts.length ? `Cannon Credits: ${parts.join(', ')}. ` : ''}Continuing needs a higher ceiling${exposure !== null ? ` of ${fmtCredits(exposure)} credits` : ''}.`,
        primary:
          exposure !== null
            ? { label: `Approve ${fmtCredits(exposure)} credits`, text: `Approve up to ${exposure} Cannon Credits for ${ref}.` }
            : { label: 'Raise the budget', text: `Raise the approved Cannon Credits budget for ${ref} enough to finish it.` }
      }
    }
    case 'first_scene_review':
      return {
        tone: 'attention',
        icon: 'eye',
        headline: 'Review the first scene',
        body: 'The first scene is rendered. Watch it before the rest of the film is rendered.',
        primary: { label: 'Looks good, continue', text: `I reviewed the first scene; continue the film ${ref}.` },
        secondary: [{ label: 'Reroll the first scene', text: `Reroll the first scene of ${ref}.` }]
      }
    case 'shot_review': {
      const flagged = arr(d.flagged).length
      return {
        tone: 'attention',
        icon: 'warning',
        headline: 'Checks flagged scenes',
        body: `The automatic checks flagged ${flagged || 'some'} scene${flagged === 1 ? '' : 's'}. Accept or reroll each one.`,
        primary: { label: 'Accept all flagged scenes', text: `Accept all flagged scenes of ${ref} as rendered and continue.` }
      }
    }
    case 'review':
      return {
        tone: 'attention',
        icon: 'eye',
        headline: 'Review the film',
        body: p.message ? redact(p.message) : 'The film is waiting for your review.',
        primary: { label: 'Reviewed, finish it', text: `I reviewed ${ref}; finish the film.` }
      }
    case 'new_revision':
      return {
        tone: 'attention',
        icon: 'sync',
        headline: 'Start a new revision',
        body: p.message ? redact(p.message) : 'The direction changed since the last render. A new revision is needed to continue.',
        primary: { label: 'Start a new revision', text: `Start a new revision of ${ref}.` }
      }
    case 'origin':
      return {
        tone: 'attention',
        icon: 'question',
        headline: 'Your decision is needed',
        body: p.message ? redact(p.message) : 'The production is waiting for a decision about its source.',
        primary: { label: 'Continue', text: `Continue ${ref}.` }
      }
    case 'recovery':
      return {
        tone: 'attention',
        icon: 'debug-restart',
        headline: 'Recover the production',
        body: p.message ? redact(p.message) : 'A step stopped partway. The agent can recover the paid work and continue.',
        primary: { label: 'Recover and continue', text: `Recover ${ref} and continue.` }
      }
    default:
      if (p.state === 'needs') {
        return {
          tone: 'attention',
          icon: 'bell-dot',
          headline: 'Your decision is needed',
          body: p.message ? redact(p.message) : 'The production is waiting for you.',
          primary: { label: 'Continue', text: `Continue ${ref}.` }
        }
      }
      return null
  }
}

// -----------------------------------------------------------------------------
// Error isolation

class Guard extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
    this.reset = () => this.setState({ error: null })
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    try {
      console.warn('[plugin:slopcannon] render failed', error)
    } catch {
      // ignore
    }
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset()
  }

  render() {
    if (this.state.error) {
      const fb = this.props.fallback
      return typeof fb === 'function' ? fb(this.reset) : fb === undefined ? null : fb
    }
    return this.props.children === undefined ? null : this.props.children
  }
}

const guard = (node, fallback = null, resetKey) => h(Guard, { fallback, resetKey }, node)

// -----------------------------------------------------------------------------
// Styles. Disk plugins are not scanned by Tailwind, so layout lives here and
// every colour is a theme variable.

const CSS = `
.sc-page{height:100%;min-height:0;overflow:auto;container-type:inline-size;color:var(--ui-text-primary);font-size:.8125rem;line-height:1.45}
.sc-page-inner{display:flex;flex-direction:column;gap:14px;padding:16px 20px 28px;max-width:1280px}
.sc-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sc-title{font-size:.9375rem;font-weight:600;letter-spacing:.04em;margin:0}
.sc-spacer{flex:1}
.sc-strip{display:flex;align-items:center;gap:6px 16px;flex-wrap:wrap;padding:8px 12px;border:1px solid var(--ui-stroke-tertiary);border-radius:6px;background:var(--ui-bg-card);font-size:.75rem}
.sc-strip-item{display:inline-flex;align-items:center;gap:6px;min-width:0}
.sc-strong{color:var(--ui-text-primary);font-weight:600;font-variant-numeric:tabular-nums}
.sc-muted{color:var(--ui-text-tertiary)}
.sc-faint{color:var(--ui-text-quaternary)}
.sc-num{font-variant-numeric:tabular-nums}
.sc-mono{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-variant-numeric:tabular-nums}
.sc-quiet{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:.75rem;color:var(--ui-text-tertiary)}
.sc-body{display:grid;grid-template-columns:minmax(220px,280px) minmax(0,1fr);gap:18px;align-items:start}
@container (max-width:760px){.sc-body{grid-template-columns:minmax(0,1fr)}}
.sc-section-label{font-size:.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--ui-text-tertiary);margin:0}
.sc-list{display:flex;flex-direction:column;gap:2px;min-width:0}
.sc-row{all:unset;box-sizing:border-box;display:flex;flex-direction:column;gap:3px;width:100%;padding:7px 10px;border-radius:5px;cursor:pointer;min-width:0}
.sc-row:hover{background:var(--ui-row-hover-background)}
.sc-row:focus-visible{outline:1px solid var(--ui-accent);outline-offset:-1px}
.sc-row[data-selected=true]{background:var(--ui-row-active-background)}
.sc-row-top{display:flex;align-items:center;gap:6px;min-width:0}
.sc-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.sc-row-meta{display:flex;gap:8px;font-size:.6875rem;color:var(--ui-text-tertiary);min-width:0}
.sc-detail{display:flex;flex-direction:column;gap:14px;min-width:0}
.sc-detail-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
.sc-detail-title{font-size:1rem;font-weight:600;margin:0;min-width:0;overflow-wrap:anywhere}
.sc-meta{display:flex;gap:4px 12px;flex-wrap:wrap;font-size:.6875rem;color:var(--ui-text-tertiary)}
.sc-stepper{display:flex;align-items:center;gap:2px;flex-wrap:wrap;list-style:none;margin:0;padding:0}
.sc-step{display:inline-flex;align-items:center;gap:5px;padding:2px 8px 2px 6px;border-radius:999px;font-size:.75rem;color:var(--ui-text-quaternary);white-space:nowrap}
.sc-step .codicon{font-size:.8125rem}
.sc-step[data-s=complete]{color:var(--ui-text-secondary)}
.sc-step[data-s=current]{color:var(--ui-text-primary);background:var(--ui-bg-quaternary)}
.sc-step[data-s=current][data-tone=attention] .codicon{color:var(--ui-accent)}
.sc-step[data-s=current][data-tone=error] .codicon{color:var(--color-destructive)}
.sc-step-sep{width:10px;height:1px;background:var(--ui-stroke-secondary);flex-shrink:0}
.sc-banner{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:6px;border:1px solid color-mix(in srgb,var(--ui-accent) 45%,transparent);background:color-mix(in srgb,var(--ui-accent) 7%,transparent)}
.sc-banner[data-tone=error]{border-color:color-mix(in srgb,var(--color-destructive) 45%,transparent);background:color-mix(in srgb,var(--color-destructive) 7%,transparent)}
.sc-banner-head{display:flex;align-items:center;gap:7px;font-weight:600}
.sc-banner[data-tone=attention] .sc-banner-head .codicon{color:var(--ui-accent)}
.sc-banner[data-tone=error] .sc-banner-head .codicon{color:var(--color-destructive)}
.sc-banner-body{color:var(--ui-text-secondary)}
.sc-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sc-statement{max-height:180px;overflow:auto;white-space:pre-wrap;font-size:.75rem;line-height:1.5;color:var(--ui-text-secondary);padding:8px 10px;border-radius:4px;background:var(--ui-bg-quaternary)}
.sc-table{display:grid;grid-template-columns:auto 1fr auto;gap:2px 14px;font-size:.75rem;align-items:baseline}
.sc-table>.sc-cell-r{text-align:right;font-variant-numeric:tabular-nums}
.sc-files{display:flex;flex-direction:column;gap:1px;font-size:.75rem;color:var(--ui-text-secondary)}
.sc-flag{display:flex;flex-direction:column;gap:4px;padding:6px 0;border-top:1px solid var(--ui-stroke-tertiary)}
.sc-flag:first-child{border-top:0}
.sc-flag-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sc-issues{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;font-size:.75rem;color:var(--ui-text-secondary)}
.sc-issues li{display:flex;gap:6px}
.sc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
.sc-scene{display:flex;flex-direction:column;gap:6px;min-width:0;padding:8px 10px;border-radius:6px;border:1px solid var(--ui-stroke-tertiary);background:var(--ui-bg-card)}
.sc-scene[data-status=failed]{border-color:color-mix(in srgb,var(--color-destructive) 40%,transparent)}
.sc-scene[data-check=fail]{border-color:color-mix(in srgb,var(--ui-yellow) 45%,transparent)}
.sc-scene-head{display:flex;align-items:center;gap:6px;min-width:0}
.sc-scene-id{font-weight:600}
.sc-scene-beat{font-size:.75rem;color:var(--ui-text-secondary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.sc-scene-foot{display:flex;align-items:center;gap:8px;font-size:.6875rem;color:var(--ui-text-tertiary);flex-wrap:wrap}
.sc-check{display:flex;flex-direction:column;gap:2px;font-size:.6875rem;color:var(--ui-text-secondary)}
.sc-check-pass .codicon{color:var(--ui-accent)}
.sc-check-fail .codicon{color:var(--ui-yellow)}
.sc-player{min-width:0;max-width:100%}
.sc-player video{display:block;max-width:100%;max-height:440px;border-radius:5px}
.sc-master{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:6px;border:1px solid var(--ui-stroke-tertiary);background:var(--ui-bg-card)}
.sc-dots{display:flex;gap:3px;flex-wrap:wrap}
.sc-dot{width:8px;height:8px;border-radius:2px;background:var(--ui-stroke-secondary);flex-shrink:0}
.sc-dot[data-s=succeeded]{background:var(--ui-accent)}
.sc-dot[data-s=running]{background:transparent;box-shadow:inset 0 0 0 1.5px var(--ui-accent);animation:sc-pulse 1.6s ease-in-out infinite}
.sc-dot[data-s=queued]{background:transparent;box-shadow:inset 0 0 0 1.5px var(--ui-stroke-primary)}
.sc-dot[data-s=failed]{background:var(--color-destructive)}
.sc-dot[data-s=uncertain]{background:var(--ui-yellow)}
.sc-dot[data-flag=fail]{box-shadow:0 0 0 1.5px var(--ui-yellow)}
@keyframes sc-pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.sc-dot{animation:none!important}}
.sc-log{margin:0;max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.6875rem;line-height:1.5;color:var(--ui-text-secondary);padding:8px 10px;border-radius:4px;background:var(--ui-bg-quaternary)}
.sc-details>summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:4px;color:var(--ui-text-tertiary);font-size:.75rem}
.sc-details>summary::-webkit-details-marker{display:none}
.sc-details[open]>summary .codicon-chevron-right{transform:rotate(90deg)}
.sc-details>summary .codicon{transition:transform .1s}
.sc-card{display:flex;flex-direction:column;gap:8px;max-width:600px;margin:6px 0;padding:10px 12px;border-radius:8px;border:1px solid var(--ui-stroke-tertiary);background:var(--ui-bg-card);font-size:.8125rem;line-height:1.45;color:var(--ui-text-primary)}
.sc-card-head{display:flex;align-items:center;gap:7px;min-width:0}
.sc-card-title{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-card-sub{display:flex;gap:4px 10px;flex-wrap:wrap;font-size:.75rem;color:var(--ui-text-tertiary)}
.sc-card .sc-banner{padding:8px 10px}
.sc-card video{display:block;max-width:100%;max-height:420px;border-radius:5px}
.sc-brand{font-size:.6875rem;font-weight:600;letter-spacing:.07em;color:var(--ui-text-tertiary)}
.sc-status{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;height:100%;padding:0 7px;font-size:.6875rem;color:var(--ui-text-tertiary);cursor:pointer;font-variant-numeric:tabular-nums;white-space:nowrap}
.sc-status:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
.sc-status:focus-visible{outline:1px solid var(--ui-accent);outline-offset:-1px}
.sc-status[data-muted=true]{color:var(--ui-text-quaternary)}
.sc-status .codicon{font-size:.75rem}
.sc-status-attn{color:var(--ui-accent)}
`

function installStyles(ctx) {
  try {
    const styleId = 'hermes-plugin-slopcannon-style'
    const old = document.getElementById(styleId)
    if (old) old.remove()
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())
  } catch {
    // no DOM (tests): styles are cosmetic
  }
}

// -----------------------------------------------------------------------------
// Small UI atoms

const icon = (name, extra = {}) => (Codicon ? h(Codicon, { name, ...extra }) : null)

function StateBadge({ state }) {
  const meta = STATE_META[state] || STATE_META.idle
  return h(Badge, { variant: meta.variant, size: 'default' }, meta.label)
}

function SceneBadge({ status }) {
  const meta = SCENE_META[status] || SCENE_META.unsubmitted
  return h(Badge, { variant: meta.variant, size: 'xs' }, meta.label)
}

function Btn(props) {
  const { label, iconName, onClick, variant = 'outline', size = 'xs', disabled, loading, title } = props
  const button = h(
    Button,
    {
      type: 'button',
      variant,
      size,
      disabled,
      loading,
      onClick: event => {
        try {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
          const out = onClick && onClick(event)
          if (out && typeof out.catch === 'function') out.catch(err => reportError(err, 'That did not work.'))
        } catch (err) {
          reportError(err, 'That did not work.')
        }
      }
    },
    iconName ? icon(iconName) : null,
    label
  )
  return title && Tip ? h(Tip, { label: title }, button) : button
}

function reportError(err, fallback) {
  try {
    if (typeof host.notifyError === 'function') host.notifyError(err, fallback)
    else notify('error', fallback)
  } catch {
    // ignore
  }
}

function SceneDots({ rows, counts }) {
  const list = Array.isArray(rows) && rows.length ? rows : null
  if (list) {
    return h(
      'div',
      { className: 'sc-dots', role: 'img', 'aria-label': sceneSummaryText(countRows(list)) },
      list.map(r =>
        h('span', {
          key: r.id,
          className: 'sc-dot',
          'data-s': r.status,
          'data-flag': r.check && r.check.verdict === 'fail' ? 'fail' : undefined,
          title: `${r.id}: ${(SCENE_META[r.status] || SCENE_META.unsubmitted).label}`
        })
      )
    )
  }
  const total = (counts && counts.total) || 0
  if (!total) return null
  const dots = []
  for (let i = 0; i < Math.min(total, 60); i++) {
    let s = 'unsubmitted'
    if (i < counts.downloaded) s = 'succeeded'
    else if (i < counts.downloaded + counts.running) s = 'running'
    else if (i < counts.downloaded + counts.running + counts.failed) s = 'failed'
    dots.push(h('span', { key: i, className: 'sc-dot', 'data-s': s }))
  }
  return h('div', { className: 'sc-dots', role: 'img', 'aria-label': sceneSummaryText(counts) }, dots)
}

function sceneSummaryText(c) {
  if (!c || !c.total) return 'No scenes planned yet'
  const parts = [`${c.downloaded}/${c.total} scenes`]
  if (c.running) parts.push(`${c.running} rendering`)
  if (c.failed) parts.push(`${c.failed} failed`)
  return parts.join(', ')
}

function progressText(p) {
  const c = p.counts
  if (!c.total) return 'Planning'
  return `${c.downloaded}/${c.total} scenes`
}

function Stepper({ production }) {
  const current = phaseOf(production)
  const currentIndex = PHASES.findIndex(x => x.id === current)
  const tone = production.state === 'error' ? 'error' : production.needs || production.state === 'needs' ? 'attention' : 'active'
  const items = []
  PHASES.forEach((phase, i) => {
    const s = production.state === 'done' || i < currentIndex ? 'complete' : i === currentIndex ? 'current' : 'pending'
    let name = 'circle-large-outline'
    let spinning = false
    if (s === 'complete') name = 'check'
    else if (s === 'current') {
      if (tone === 'error') name = 'error'
      else if (tone === 'attention') name = 'circle-filled'
      else if (production.state === 'running') {
        name = 'loading'
        spinning = true
      } else name = 'circle-filled'
    }
    if (i > 0) items.push(h('li', { key: `sep-${phase.id}`, className: 'sc-step-sep', 'aria-hidden': true }))
    items.push(
      h(
        'li',
        {
          key: phase.id,
          className: 'sc-step',
          'data-s': s,
          'data-tone': s === 'current' ? tone : undefined,
          'aria-current': s === 'current' ? 'step' : undefined
        },
        icon(name, { spinning }),
        phase.label
      )
    )
  })
  return h('ol', { className: 'sc-stepper', 'aria-label': 'Production phases' }, items)
}

// Plays a file on the backend's machine through Desktop's own media pipeline:
// a `MEDIA:` line rendered by the SDK's MessageTextContent becomes the
// built-in player, streamed by the gateway's ticketed Range route. Plugins
// cannot mint that URL themselves (ctx.rest is JSON only), so this is the
// sanctioned door for the studio page.
function BackendClip({ clip }) {
  if (!clip || !clip.path) return null
  const MessageTextContent = sdk.MessageTextContent
  if (!MessageTextContent) return h(RevealFallback, { clip })
  const q = clip.path.includes('"') ? '`' : '"'
  return guard(
    h('div', { className: 'sc-player' }, h(MessageTextContent, { text: `MEDIA:${q}${clip.path}${q}` })),
    h(RevealFallback, { clip }),
    clip.path
  )
}

function RevealFallback({ clip }) {
  return h(
    'div',
    { className: 'sc-quiet' },
    icon('device-camera-video'),
    h('span', null, clip.name || baseName(clip.path)),
    h(Btn, { label: 'Show in folder', iconName: 'folder-opened', variant: 'ghost', onClick: () => reveal(clip.path) })
  )
}

async function reveal(path) {
  let ok = false
  try {
    ok = Boolean(CTX && (await CTX.os.revealPath(path)))
  } catch {
    ok = false
  }
  if (!ok) notify('warning', 'This file is on the backend machine and cannot be shown from here.')
}

function openStudio(productionId) {
  if (productionId && PRODUCTION_ID.test(productionId)) {
    $selected.set(productionId)
    try {
      CTX && CTX.storage.set('selected', productionId)
    } catch {
      // ignore
    }
  }
  try {
    host.navigate(ROUTE)
  } catch (err) {
    reportError(err, 'Could not open the SLOPCANNON studio.')
  }
}

// Copies the sign-in command; Hermes runs the sign-in itself, in a terminal on the backend machine.
async function signIn(command) {
  const text = command || SIGN_IN_COMMAND
  let copied = false
  try {
    copied = Boolean(CTX && (await CTX.os.writeClipboard(text)))
  } catch {
    copied = false
  }
  notify(
    copied ? 'info' : 'warning',
    copied
      ? `Copied \`${text}\`. Run it in a terminal on the Hermes machine, then refresh the studio.`
      : `Run \`${text}\` in a terminal on the Hermes machine, then refresh the studio.`
  )
}

async function topUp() {
  let ok = false
  try {
    ok = Boolean(CTX && (await CTX.os.openExternal(TOP_UP_URL)))
  } catch {
    ok = false
  }
  if (!ok) notify('warning', `Open ${TOP_UP_URL} in a browser to buy Cannon Credits.`)
}

// -----------------------------------------------------------------------------
// Studio: account strip

const VIA_LABEL = { 'hermes sign-in': 'Hermes sign-in', 'personal token': 'personal token' }

function AccountStrip() {
  const status = useStatus()
  if (status.isLoading && !status.data) {
    return h('div', { className: 'sc-strip' }, h('span', { className: 'sc-muted' }, 'Checking the SLOPCANNON account'))
  }
  if (!status.data) {
    return h(
      'div',
      { className: 'sc-strip' },
      h('span', { className: 'sc-strip-item sc-muted' }, icon('circle-slash'), backendDownText(status.error)),
      h('span', { className: 'sc-spacer' }),
      h(Btn, { label: 'Retry', iconName: 'refresh', variant: 'ghost', onClick: invalidateAll })
    )
  }
  const s = status.data
  if (!s.connected) {
    return h(
      'div',
      { className: 'sc-strip' },
      h('span', { className: 'sc-strip-item' }, icon('account'), h('span', { className: 'sc-strong' }, 'Not signed in')),
      h(
        'span',
        { className: 'sc-strip-item sc-muted' },
        'Run',
        h('span', { className: 'sc-mono' }, s.signInCommand),
        'in a terminal, or set a personal token in the plugin settings'
      ),
      s.error ? h('span', { className: 'sc-strip-item sc-muted' }, redact(s.error)) : null,
      h('span', { className: 'sc-spacer' }),
      h(Btn, { label: 'Copy command', iconName: 'copy', variant: 'default', onClick: () => signIn(s.signInCommand) })
    )
  }
  const c = s.credits
  const svc = s.service
  const expiresMs = s.expiresAt ? s.expiresAt * 1000 : null
  const expires = expiresMs ? (expiresMs > Date.now() ? `session ${fmtWhen(expiresMs)}` : 'session expired') : null
  return h(
    'div',
    { className: 'sc-strip' },
    h(
      'span',
      { className: 'sc-strip-item' },
      icon('pass'),
      h('span', { className: 'sc-strong' }, 'Signed in'),
      s.via ? h('span', { className: 'sc-muted' }, `via ${VIA_LABEL[s.via] || s.via}`) : null,
      expires ? h('span', { className: 'sc-faint', title: fmtWhenAbsolute(expiresMs) }, expires) : null
    ),
    c
      ? h(
          'span',
          { className: 'sc-strip-item' },
          icon('credit-card'),
          h('span', { className: 'sc-strong' }, fmtCredits(c.available)),
          h('span', { className: 'sc-muted' }, 'credits available'),
          c.reserved ? h('span', { className: 'sc-muted' }, `${fmtCredits(c.reserved)} held`) : null
        )
      : null,
    svc.status || svc.submissionReady !== null
      ? h(
          'span',
          { className: 'sc-strip-item sc-muted' },
          icon(svc.submissionReady === false ? 'warning' : 'pulse'),
          `Service ${svc.status || 'unknown'}`,
          svc.submissionReady === false ? h('span', null, ', not accepting renders') : null
        )
      : null,
    s.error ? h('span', { className: 'sc-strip-item sc-muted' }, redact(s.error)) : null,
    s.node && !s.node.ok
      ? h('span', { className: 'sc-strip-item sc-muted' }, icon('warning'), s.node.message || 'Node.js is missing on the backend machine; productions cannot run.')
      : null,
    h('span', { className: 'sc-spacer' }),
    h(Btn, { label: 'Top up', iconName: 'link-external', variant: 'ghost', onClick: topUp }),
    h(Btn, { label: 'Refresh', iconName: 'refresh', variant: 'ghost', onClick: invalidateAll })
  )
}

// -----------------------------------------------------------------------------
// Studio: production list

function ProductionList({ list, selectedId, onSelect }) {
  return h(
    'div',
    { className: 'sc-list', role: 'list', 'aria-label': 'Productions' },
    list.map(p =>
      h(
        'button',
        {
          key: p.id,
          type: 'button',
          role: 'listitem',
          className: 'sc-row',
          'data-selected': p.id === selectedId ? 'true' : 'false',
          'aria-current': p.id === selectedId ? 'true' : undefined,
          onClick: () => onSelect(p.id)
        },
        h(
          'span',
          { className: 'sc-row-top' },
          h('span', { className: 'sc-row-title', title: p.title }, p.title),
          h(StateBadge, { state: p.state })
        ),
        h(
          'span',
          { className: 'sc-row-meta' },
          h('span', { className: 'sc-num' }, progressText(p)),
          p.counts.running ? h('span', null, `${p.counts.running} rendering`) : null,
          p.needs ? h('span', null, phaseLabel(phaseOf(p))) : null,
          h('span', { className: 'sc-spacer' }),
          p.updatedAt ? h('span', { title: fmtWhenAbsolute(p.updatedAt) }, fmtWhen(p.updatedAt)) : null
        )
      )
    )
  )
}

// -----------------------------------------------------------------------------
// Studio: needs banner (shared with the transcript card)

function NeedsBanner({ production, send, compact }) {
  const model = needsModel(production)
  if (!model) return null
  const d = obj(production.needsDetail)
  const extra = compact ? null : NeedsDetail({ production, detail: d, send })
  return h(
    'div',
    { className: 'sc-banner', 'data-tone': model.tone, role: 'status' },
    h('div', { className: 'sc-banner-head' }, icon(model.icon), model.headline),
    h('div', { className: 'sc-banner-body' }, model.body),
    extra,
    h(
      'div',
      { className: 'sc-actions' },
      model.primary
        ? h(Btn, { label: model.primary.label, variant: 'default', size: 'sm', onClick: () => send(model.primary.text), title: model.primary.text })
        : null,
      arr(model.secondary).map(s =>
        h(Btn, { key: s.label, label: s.label, variant: 'ghost', size: 'sm', onClick: () => send(s.text), title: s.text })
      )
    )
  )
}

function NeedsDetail({ production, detail, send }) {
  switch (production.needs) {
    case 'rights': {
      const files = arr(detail.files).map(obj)
      return h(
        Fragment,
        null,
        str(detail.statement) ? h('div', { className: 'sc-statement' }, detail.statement) : null,
        files.length
          ? h(
              'div',
              { className: 'sc-files' },
              files.map((f, i) =>
                h(
                  'span',
                  { key: `${str(f.name) || ''}-${i}` },
                  icon('file'),
                  ' ',
                  str(f.name) || 'file',
                  fmtBytes(num(f.bytes)) ? h('span', { className: 'sc-faint' }, `  ${fmtBytes(num(f.bytes))}`) : null
                )
              )
            )
          : null
      )
    }
    case 'approval': {
      const quotes = arr(detail.quotes).map(obj)
      if (!quotes.length) return null
      const cells = []
      quotes.forEach((q, i) => {
        const scene = str(q.scene) || `#${i + 1}`
        cells.push(h('span', { key: `s${i}`, className: 'sc-mono' }, scene))
        cells.push(h('span', { key: `g${i}` }))
        cells.push(h('span', { key: `c${i}`, className: 'sc-cell-r' }, `${fmtCredits(int(q.amountUnits))} cr`))
      })
      const total = needsTotalCredits(production)
      if (total !== null) {
        cells.push(h('span', { key: 'tl', className: 'sc-strong' }, 'Total'))
        cells.push(h('span', { key: 'tg' }))
        cells.push(h('span', { key: 'tc', className: 'sc-cell-r sc-strong' }, `${fmtCredits(total)} cr`))
      }
      return h('div', { className: 'sc-table' }, cells)
    }
    case 'first_scene_review': {
      const clip = normClip(detail.clip)
      return clip ? h(BackendClip, { clip }) : null
    }
    case 'shot_review': {
      const flagged = arr(detail.flagged).map(obj)
      if (!flagged.length) return null
      const ref = filmRef(production)
      return h(
        'div',
        null,
        flagged.map((f, i) => {
          const scene = str(f.scene) || `#${i + 1}`
          const issues = arr(f.issues).map(normIssue)
          return h(
            'div',
            { key: `${scene}-${i}`, className: 'sc-flag' },
            h(
              'div',
              { className: 'sc-flag-head' },
              h('span', { className: 'sc-mono sc-strong' }, scene),
              str(f.verdict) ? h('span', { className: 'sc-muted' }, f.verdict) : null,
              h('span', { className: 'sc-spacer' }),
              h(Btn, { label: 'Accept', iconName: 'check', variant: 'outline', onClick: () => send(`Accept scene ${scene} of ${ref} as rendered.`) }),
              h(Btn, { label: 'Reroll', iconName: 'refresh', variant: 'ghost', onClick: () => send(`Reroll scene ${scene} of ${ref}.`) })
            ),
            issues.length ? h(IssueList, { issues }) : null
          )
        })
      )
    }
    default:
      return null
  }
}

function IssueList({ issues }) {
  return h(
    'ul',
    { className: 'sc-issues' },
    issues.map((iss, i) =>
      h(
        'li',
        { key: i },
        iss.second !== null ? h('span', { className: 'sc-mono sc-muted' }, fmtClock(iss.second * 1000)) : null,
        h(
          'span',
          null,
          [iss.kind, iss.character].filter(Boolean).join(', ') || 'issue',
          iss.description ? `: ${iss.description}` : ''
        )
      )
    )
  )
}

// -----------------------------------------------------------------------------
// Studio: scenes

function SceneCard({ scene, production, send }) {
  const [open, setOpen] = useState(false)
  const range = fmtRange(scene.startMs, scene.endMs)
  const check = scene.check
  const ref = filmRef(production)
  const showReroll = scene.status === 'failed' || (check && check.verdict === 'fail')
  // A take the check never judged is not a pass: say so once the run has stopped waiting on it, or as soon as
  // the driver recorded why the check could not run.
  const notChecked = scene.clip && (!check || check.verdict === 'unchecked') &&
    ((check && check.error) || production.state !== 'running')
  return h(
    'div',
    {
      className: 'sc-scene',
      'data-status': scene.status,
      'data-check': check ? check.verdict : undefined
    },
    h(
      'div',
      { className: 'sc-scene-head' },
      h('span', { className: 'sc-mono sc-scene-id' }, scene.id),
      range ? h('span', { className: 'sc-mono sc-muted' }, range) : null,
      h('span', { className: 'sc-spacer' }),
      h(SceneBadge, { status: scene.status })
    ),
    scene.beat ? h('div', { className: 'sc-scene-beat', title: scene.beat }, scene.beat) : null,
    check && check.verdict !== 'unchecked'
      ? h(
          'div',
          { className: `sc-check ${check.verdict === 'pass' ? 'sc-check-pass' : 'sc-check-fail'}` },
          h('span', null, icon(check.verdict === 'pass' ? 'pass' : 'warning'), check.verdict === 'pass' ? ' Check passed' : ' Check flagged'),
          check.issues.length ? h(IssueList, { issues: check.issues }) : null
        )
      : notChecked
        ? h(
            'div',
            { className: 'sc-check sc-check-fail' },
            h('span', null, icon('warning'), ' Not checked'),
            check && check.error ? h('div', { className: 'sc-muted' }, check.error.message) : null
          )
        : null,
    open && scene.clip ? h(BackendClip, { clip: scene.clip }) : null,
    h(
      'div',
      { className: 'sc-scene-foot' },
      scene.quoteCredits !== null ? h('span', { className: 'sc-num' }, `${fmtCredits(scene.quoteCredits)} cr`) : null,
      h('span', { className: 'sc-spacer' }),
      showReroll ? h(Btn, { label: 'Reroll', iconName: 'refresh', variant: 'ghost', onClick: () => send(`Reroll scene ${scene.id} of ${ref}.`) }) : null,
      scene.clip
        ? h(Btn, {
            label: open ? 'Hide' : 'Play',
            iconName: open ? 'eye-closed' : 'play',
            variant: 'ghost',
            onClick: () => setOpen(v => !v)
          })
        : null
    )
  )
}

function SceneGrid({ production, send }) {
  const rows = production.rows || []
  if (!rows.length) {
    return production.counts.total ? h('div', { className: 'sc-quiet' }, 'Loading scenes') : null
  }
  return h(
    'div',
    { className: 'sc-grid' },
    rows.map(scene => h(Guard, { key: scene.id, fallback: null, resetKey: scene.id }, h(SceneCard, { scene, production, send })))
  )
}

// -----------------------------------------------------------------------------
// Studio: detail

function MasterPanel({ production }) {
  const master = production.master
  if (!master) return null
  const save = savers.get(production.id)
  return h(
    'div',
    { className: 'sc-master' },
    h('div', { className: 'sc-actions' }, h('span', { className: 'sc-section-label' }, 'Finished film'), h('span', { className: 'sc-muted' }, master.name)),
    h(BackendClip, { clip: master }),
    h(
      'div',
      { className: 'sc-actions' },
      typeof save === 'function'
        ? h(Btn, { label: 'Save a copy', iconName: 'cloud-download', variant: 'outline', onClick: () => save(master.path, master.name) })
        : null,
      h(Btn, { label: 'Show in folder', iconName: 'folder-opened', variant: 'ghost', onClick: () => reveal(master.path) })
    )
  )
}

function StopControl({ production }) {
  const [open, setOpen] = useState(false)
  if (production.state !== 'running') return null
  const stop = async () => {
    const r = obj(await api(`/productions/${encodeURIComponent(production.id)}/stop`, { method: 'POST', body: {} }))
    notify(r.stopped ? 'info' : 'warning', r.stopped ? `Stopped ${production.title}.` : 'Nothing was running to stop.')
    invalidateAll()
  }
  return h(
    Fragment,
    null,
    h(Btn, { label: 'Stop', iconName: 'debug-stop', variant: 'outline', onClick: () => setOpen(true) }),
    ConfirmDialog
      ? h(ConfirmDialog, {
          open,
          onClose: () => setOpen(false),
          onConfirm: stop,
          title: `Stop ${production.title}?`,
          description:
            'This stops the local production run. Renders already submitted to SLOPCANNON may still finish, and their credits stay committed. The agent can resume the production later.',
          confirmLabel: 'Stop production',
          destructive: true
        })
      : null
  )
}

function ProductionDetail({ id, summary }) {
  const q = useProduction(id)
  const p = q.data || summary
  if (!p) {
    if (q.isError) return h('div', { className: 'sc-quiet' }, icon('circle-slash'), isNotFound(q.error) ? 'This production no longer exists.' : backendDownText(q.error))
    return h('div', { className: 'sc-quiet' }, 'Loading the production')
  }
  const send = text => sendFromStudio(p, text)
  const meta = []
  if (p.aspectRatio) meta.push(h('span', { key: 'ar' }, p.aspectRatio))
  if (p.updatedAt) meta.push(h('span', { key: 'up', title: fmtWhenAbsolute(p.updatedAt) }, `updated ${fmtWhen(p.updatedAt)}`))
  if (p.spend.approvedCredits !== null) meta.push(h('span', { key: 'ap', className: 'sc-num' }, `${fmtCredits(p.spend.approvedCredits)} cr approved`))
  if (p.spend.committedCredits !== null) meta.push(h('span', { key: 'cm', className: 'sc-num' }, `${fmtCredits(p.spend.committedCredits)} cr committed`))
  meta.push(h('span', { key: 'id', className: 'sc-mono sc-faint' }, p.id))
  const c = p.counts
  return h(
    'div',
    { className: 'sc-detail' },
    h(
      'div',
      { className: 'sc-detail-head' },
      h('div', { style: { minWidth: 0, flex: 1 } }, h('h2', { className: 'sc-detail-title' }, p.title), h('div', { className: 'sc-meta' }, meta)),
      h(StateBadge, { state: p.state }),
      h(StopControl, { production: p })
    ),
    guard(h(Stepper, { production: p })),
    p.message && !needsModel(p) ? h('div', { className: 'sc-quiet' }, redact(p.message)) : null,
    guard(h(NeedsBanner, { production: p, send }), null, `${p.id}:${p.needs}`),
    guard(h(MasterPanel, { production: p }), null, p.master ? p.master.path : ''),
    h(
      'div',
      { className: 'sc-actions' },
      h('h3', { className: 'sc-section-label' }, 'Scenes'),
      h('span', { className: 'sc-muted sc-num' }, sceneSummaryText(c))
    ),
    q.isError && !q.data ? h('div', { className: 'sc-quiet' }, icon('circle-slash'), backendDownText(q.error)) : null,
    guard(h(SceneGrid, { production: p, send }), null, p.id),
    p.log && p.log.length
      ? h(
          'details',
          { className: 'sc-details' },
          h('summary', null, icon('chevron-right'), 'Driver log'),
          h('pre', { className: 'sc-log' }, p.log.map(redact).join('\n'))
        )
      : null
  )
}

function pickDefault(list) {
  if (!list.length) return null
  const needing = list.find(p => p.state === 'needs' || p.needs)
  if (needing) return needing.id
  const running = list.find(p => p.state === 'running')
  return (running || list[0]).id
}

function StudioPage() {
  const productions = useProductions()
  const selected = useValue($selected)
  const list = productions.data || []
  const selectedId = selected && list.some(p => p.id === selected) ? selected : pickDefault(list)
  const select = id => {
    $selected.set(id)
    try {
      CTX && CTX.storage.set('selected', id)
    } catch {
      // ignore
    }
  }
  let body
  if (productions.isLoading && !productions.data) {
    body = h('div', { className: 'sc-quiet' }, 'Loading productions')
  } else if (!productions.data) {
    body = h(
      'div',
      { className: 'sc-quiet' },
      icon('circle-slash'),
      backendDownText(productions.error),
      h(Btn, { label: 'Retry', iconName: 'refresh', variant: 'ghost', onClick: invalidateAll })
    )
  } else if (!list.length) {
    body = sdk.EmptyState
      ? h(sdk.EmptyState, { title: 'No productions yet', description: 'Ask the agent to make a music video. Productions it starts show up here.' })
      : h('div', { className: 'sc-quiet' }, 'No productions yet. Ask the agent to make a music video.')
  } else {
    const summary = list.find(p => p.id === selectedId) || null
    body = h(
      'div',
      { className: 'sc-body' },
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
        h('h3', { className: 'sc-section-label' }, `Productions (${list.length})`),
        guard(h(ProductionList, { list, selectedId, onSelect: select }))
      ),
      selectedId
        ? guard(
            h(ProductionDetail, { key: selectedId, id: selectedId, summary }),
            reset => h('div', { className: 'sc-quiet' }, 'This production could not be shown.', h(Btn, { label: 'Try again', variant: 'ghost', onClick: reset })),
            selectedId
          )
        : null
    )
  }
  return h(
    'div',
    { className: 'sc-page' },
    h(
      'div',
      { className: 'sc-page-inner' },
      h('div', { className: 'sc-head' }, icon('device-camera-video', { size: '1rem' }), h('h1', { className: 'sc-title' }, 'SLOPCANNON'), h('span', { className: 'sc-muted' }, 'Studio')),
      guard(h(AccountStrip)),
      body
    )
  )
}

// -----------------------------------------------------------------------------
// Status bar

function StatusItem() {
  const status = useStatus()
  const productions = useProductions()
  if (!status.data) return null
  const s = status.data
  if (!s.connected) {
    return h(
      'button',
      { type: 'button', className: 'sc-status', 'data-muted': 'true', onClick: () => openStudio(), 'aria-label': 'SLOPCANNON: not signed in. Open the studio.' },
      'SLOPCANNON: sign in'
    )
  }
  const list = productions.data || []
  const running = list.filter(p => p.state === 'running').length
  const waiting = list.filter(p => p.state === 'needs' || (p.needs && p.state !== 'done')).length
  const c = s.credits
  const tipParts = ['SLOPCANNON']
  if (c && c.available !== null) tipParts.push(`${fmtCredits(c.available)} Cannon Credits available${c.reserved ? `, ${fmtCredits(c.reserved)} held` : ''}`)
  if (running) tipParts.push(`${running} production${running === 1 ? '' : 's'} rendering`)
  if (waiting) tipParts.push(`${waiting} waiting for you`)
  const tip = tipParts.join('. ')
  const button = h(
    'button',
    { type: 'button', className: 'sc-status', onClick: () => openStudio(), 'aria-label': `${tip}. Open the studio.` },
    icon('device-camera-video'),
    h('span', null, c && c.available !== null ? `${fmtCredits(c.available)} cr` : 'SLOPCANNON'),
    running ? h(Fragment, null, icon('loading', { spinning: true }), h('span', null, String(running))) : null,
    waiting ? h('span', { className: 'sc-status-attn' }, icon('bell-dot')) : null
  )
  return Tip ? h(Tip, { label: tip }, button) : button
}

// -----------------------------------------------------------------------------
// Transcript directive: ::slopcannon-film{id="..."}

function FilmCard({ productionId, sessionId }) {
  useEffect(() => {
    if (sessionId) rememberSession(productionId, sessionId)
  }, [productionId, sessionId])
  const q = useProduction(productionId)
  const p = q.data
  if (!p) {
    if (q.isError) {
      return h(
        'div',
        { className: 'sc-card' },
        h('div', { className: 'sc-card-head' }, h('span', { className: 'sc-brand' }, 'SLOPCANNON'), h('span', { className: 'sc-mono sc-muted' }, productionId)),
        h('div', { className: 'sc-quiet' }, isNotFound(q.error) ? 'This production is not on this machine.' : backendDownText(q.error))
      )
    }
    return h(
      'div',
      { className: 'sc-card' },
      h('div', { className: 'sc-card-head' }, h('span', { className: 'sc-brand' }, 'SLOPCANNON'), h('span', { className: 'sc-muted' }, 'Loading the production'))
    )
  }
  const send = text => sendFromCard(sessionId, text)
  return h(
    'div',
    { className: 'sc-card' },
    h(
      'div',
      { className: 'sc-card-head' },
      icon('device-camera-video'),
      h('span', { className: 'sc-card-title', title: p.title }, p.title),
      h(StateBadge, { state: p.state })
    ),
    h(
      'div',
      { className: 'sc-card-sub' },
      h('span', null, phaseLabel(phaseOf(p))),
      h('span', { className: 'sc-num' }, sceneSummaryText(p.counts)),
      p.updatedAt ? h('span', { title: fmtWhenAbsolute(p.updatedAt) }, fmtWhen(p.updatedAt)) : null
    ),
    h(SceneDots, { rows: p.rows, counts: p.counts }),
    guard(h(NeedsBanner, { production: p, send, compact: true }), null, `${p.id}:${p.needs}`),
    h(
      'div',
      { className: 'sc-actions' },
      h(Btn, { label: 'Open in SLOPCANNON studio', iconName: 'arrow-right', variant: 'ghost', onClick: () => openStudio(p.id) })
    )
  )
}

function renderDirective(props) {
  const attrs = obj(props && props.attrs)
  const id = typeof attrs.id === 'string' ? attrs.id.trim() : ''
  if (!PRODUCTION_ID.test(id)) return null
  const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : null
  return guard(h(FilmCard, { productionId: id, sessionId }), null, id)
}

// -----------------------------------------------------------------------------
// Tool media renderer: clip cards for this package's own tools

function clipContext(toolName, args, result, file) {
  const r = obj(parseMaybeJson(result))
  const a = obj(args)
  const out = { kind: 'clip', productionId: null, title: null, needs: null, sceneId: null, generationId: null, assemblyId: null }
  const sceneArg = [a.sceneId, a.scene_id, a.scene].find(v => typeof v === 'string' && /^sc\d{1,3}$/i.test(v))
  if (sceneArg) out.sceneId = sceneArg
  const idArg = [a.productionId, a.production_id, a.id].find(v => typeof v === 'string' && PRODUCTION_ID.test(v))
  if (idArg) out.productionId = idArg

  if (PRODUCTION_TOOLS.has(toolName)) {
    const p = normProduction(r.production)
    if (p) {
      out.productionId = p.id
      out.title = p.title
      out.needs = p.needs
      const d = obj(p.needsDetail)
      if (p.master && samePath(p.master.path, file.path)) out.kind = 'master'
      else if (p.needs === 'first_scene_review') {
        out.kind = 'first'
        if (typeof d.scene === 'string') out.sceneId = d.scene
      } else if (p.state === 'done' && !p.needs) out.kind = 'master'
      if (Array.isArray(p.rows)) {
        const row = p.rows.find(x => x.clip && samePath(x.clip.path, file.path))
        if (row) {
          out.sceneId = row.id
          out.generationId = row.generationId
          if (out.kind === 'master') out.kind = 'clip'
        }
      }
    }
    return out
  }

  // slopcannon_wait / slopcannon_download
  if (str(r.assemblyId) && (!str(r.path) || samePath(r.path, file.path))) {
    out.kind = 'master'
    out.assemblyId = r.assemblyId
  }
  const assembly = obj(r.assembly)
  if (str(assembly.path) && samePath(assembly.path, file.path)) {
    out.kind = 'master'
    out.assemblyId = str(assembly.assemblyId) || str(assembly.id) || out.assemblyId
  }
  if (str(r.generationId) && (!str(r.path) || samePath(r.path, file.path))) out.generationId = r.generationId
  const finished = obj(r.finished)
  for (const [gid, entry] of Object.entries(finished)) {
    if (samePath(obj(entry).path, file.path)) {
      out.generationId = gid
      break
    }
  }
  if (!out.generationId) {
    const gidArg = [a.generation_id, a.generationId].find(v => typeof v === 'string' && v.trim())
    if (gidArg && out.kind !== 'master') out.generationId = gidArg
  }
  return out
}

function ToolClipCard(props) {
  const { file, fallback } = props
  if (!file || file.kind !== 'video' || typeof file.resolveUrl !== 'function') return fallback === undefined ? null : fallback
  return h(ToolClipCardInner, props)
}

function ToolClipCardInner({ file, toolName, args, result, sessionId, fallback }) {
  const info = useMemo(() => {
    try {
      return clipContext(toolName, args, result, file)
    } catch {
      return { kind: 'clip' }
    }
  }, [toolName, args, result, file])
  const [src, setSrc] = useState(null)
  useEffect(() => {
    let live = true
    let p
    try {
      p = Promise.resolve(file.resolveUrl())
    } catch (err) {
      p = Promise.reject(err)
    }
    p.then(
      url => live && setSrc(typeof url === 'string' && url ? url : ''),
      () => live && setSrc('')
    )
    return () => {
      live = false
    }
  }, [file])
  useEffect(() => {
    if (info.productionId && sessionId) rememberSession(info.productionId, sessionId)
  }, [info.productionId, sessionId])

  if (src === '') return fallback === undefined ? null : fallback

  const ref = info.productionId ? filmRef({ id: info.productionId, title: info.title || info.productionId }) : null
  // "scene sc02 of "Title" (production id), generation gen_b" with whatever is known.
  const subject = (fallbackSubject, fallbackName) => {
    let text = info.sceneId ? `scene ${info.sceneId}` : fallbackSubject
    if (ref) text += ` of ${ref}`
    if (info.generationId) text += `, generation ${info.generationId}`
    else if (!info.sceneId && !ref && fallbackName) text += ` (${fallbackName})`
    return text
  }
  const send = text => sendFromCard(sessionId, text)

  const kindLabel = info.kind === 'master' ? 'Finished film' : info.kind === 'first' ? 'First scene, waiting for your review' : 'Scene clip'
  const caption = [info.title, kindLabel, info.sceneId].filter(Boolean).join(', ')

  const actions = []
  if (info.kind === 'first') {
    actions.push(
      h(Btn, {
        key: 'continue',
        label: 'Looks good, continue the film',
        iconName: 'check',
        variant: 'default',
        size: 'sm',
        onClick: () => send(`Looks good, continue the film${ref ? ` ${ref}` : ''}.`)
      })
    )
  }
  if (info.kind !== 'master') {
    actions.push(
      h(Btn, {
        key: 'check',
        label: 'Check this take for defects',
        iconName: 'eye',
        variant: info.kind === 'first' ? 'ghost' : 'outline',
        size: 'sm',
        onClick: () => send(`Check ${subject('this take', file.name)} for defects.`)
      }),
      h(Btn, {
        key: 'reroll',
        label: 'Reroll this scene',
        iconName: 'refresh',
        variant: 'ghost',
        size: 'sm',
        onClick: () =>
          send(`Reroll ${subject('this scene', file.name)}.`)
      })
    )
  }
  actions.push(
    h(Btn, {
      key: 'studio',
      label: 'Open in SLOPCANNON studio',
      iconName: 'arrow-right',
      variant: 'ghost',
      size: 'sm',
      onClick: () => openStudio(info.productionId)
    })
  )

  return h(
    'figure',
    { className: 'sc-card', style: { marginInline: 0 } },
    h(
      'figcaption',
      { className: 'sc-card-head' },
      icon('device-camera-video'),
      h('span', { className: 'sc-card-title', title: caption || file.name }, caption || 'SLOPCANNON clip'),
      h('span', { className: 'sc-faint', title: file.name }, file.name)
    ),
    src
      ? h('video', { src, controls: true, preload: 'metadata', playsInline: true, 'aria-label': caption || file.name })
      : h('div', { className: 'sc-quiet' }, 'Loading the clip'),
    h('div', { className: 'sc-actions' }, actions)
  )
}

// -----------------------------------------------------------------------------
// Live events

function onProductionEvent(event) {
  invalidateAll()
  const payload = obj(event && event.payload)
  const id = str(payload.id)
  if (!id) return
  const needs = str(payload.needs)
  const state = str(payload.state)
  const key = `${state || ''}:${needs || ''}`
  const prev = lastSeenNeeds.get(id)
  lastSeenNeeds.set(id, key)
  if (prev === undefined || prev === key) return
  if (!needs && state !== 'done' && state !== 'error') return
  // A native notification fires only while the person is away from Hermes.
  let title = id
  try {
    for (const [, data] of queryClient.getQueriesData({ queryKey: keys.all })) {
      if (Array.isArray(data)) {
        const hit = data.find(p => p && p.id === id)
        if (hit) title = hit.title
      } else if (data && data.id === id) title = data.title
    }
  } catch {
    // titles are cosmetic
  }
  const model = state === 'done' ? null : needsModel({ id, title, state, needs, needsDetail: null, counts: { total: 0 }, spend: {}, message: null })
  const body = state === 'done' ? 'The film is finished.' : model ? model.headline : 'The production changed.'
  try {
    if (CTX && CTX.os && typeof CTX.os.notify === 'function') {
      CTX.os.notify({
        title: `SLOPCANNON: ${title}`,
        body,
        activate: ROUTE,
        onActivate: () => $selected.set(id)
      })
    }
  } catch {
    // notifications are optional
  }
}

// -----------------------------------------------------------------------------
// Plugin

export default {
  id: ID,
  name: 'SLOPCANNON',
  description: 'SLOPCANNON music-video productions inside Hermes: studio page, credits in the status bar, inline production cards and clip players.',
  defaultEnabled: true,
  register(ctx) {
    CTX = ctx
    lastSeenNeeds.clear()
    savers.clear()
    try {
      const saved = ctx.storage.get('selected', null)
      $selected.set(typeof saved === 'string' && PRODUCTION_ID.test(saved) ? saved : null)
    } catch {
      $selected.set(null)
    }
    ctx.onDispose(() => {
      if (CTX === ctx) CTX = null
    })

    installStyles(ctx)

    ctx.registerMany([
      {
        id: 'studio',
        area: ROUTES_AREA,
        data: { path: ROUTE },
        render: () =>
          guard(h(StudioPage), reset =>
            h(
              'div',
              { className: 'sc-page' },
              h(
                'div',
                { className: 'sc-page-inner' },
                h('div', { className: 'sc-quiet' }, 'The SLOPCANNON studio hit an error.', h(Btn, { label: 'Reload the studio', variant: 'ghost', onClick: reset }))
              )
            )
          )
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 60,
        data: { path: ROUTE, label: 'SLOPCANNON', codicon: 'device-camera-video' }
      },
      {
        id: 'status',
        area: STATUSBAR_AREAS.right,
        order: 95,
        render: () => guard(h(StatusItem))
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'slopcannon.openStudio',
          label: 'SLOPCANNON: Open studio',
          keywords: ['slopcannon', 'music video', 'film', 'studio', 'productions'],
          run: () => openStudio()
        }
      },
      {
        id: 'sign-in',
        area: PALETTE_AREA,
        data: {
          id: 'slopcannon.signIn',
          label: 'SLOPCANNON: Copy sign-in command',
          keywords: ['slopcannon', 'login', 'sign in', 'account', 'hermes auth add'],
          run: () => void signIn()
        }
      },
      {
        id: 'refresh',
        area: PALETTE_AREA,
        data: {
          id: 'slopcannon.refresh',
          label: 'SLOPCANNON: Refresh',
          keywords: ['slopcannon', 'refresh', 'reload', 'credits'],
          run: () => {
            invalidateAll()
            notify('info', 'Refreshing SLOPCANNON.')
          }
        }
      }
    ])

    if (typeof sdk.TRANSCRIPT_DIRECTIVE_AREA === 'string') {
      ctx.register({
        id: 'film-card',
        area: sdk.TRANSCRIPT_DIRECTIVE_AREA,
        data: { name: 'slopcannon-film', render: renderDirective }
      })
    }

    if (typeof sdk.TOOL_MEDIA_RENDERER_AREA === 'string') {
      ctx.register({
        id: 'clip-card',
        area: sdk.TOOL_MEDIA_RENDERER_AREA,
        data: {
          tools: MEDIA_TOOLS,
          render: props => guard(h(ToolClipCard, props), props && props.fallback !== undefined ? props.fallback : null)
        }
      })
    }

    ctx.onEvent('plugin.slopcannon.production.updated', event => {
      try {
        onProductionEvent(event)
      } catch {
        invalidateAll()
      }
    })
    ctx.onEvent('plugin.slopcannon.account.updated', () => {
      try {
        queryClient.invalidateQueries({ queryKey: keys.all })
      } catch {
        // ignore
      }
    })
  }
}
