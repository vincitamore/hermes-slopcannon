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
//   - palette: Open studio, Ask for a music video, Copy sign-in command, Refresh
//   - transcript directive `::slopcannon-film{id="<production id>"}`: one card
//     that changes in place (needs you, rendering, done)
//   - tool media renderer for this package's own tools' MEDIA files (scene card)
//
// Design: Hermes's own primitives (Button, Badge, Loader, Tip, ConfirmDialog) and
// live theme variables only; the film's frames carry the colour. Frames and
// the song envelope come from the backend (media.py) by opaque cache name.
//
// Backend: dashboard/plugin_api.py, reached with ctx.rest('/...'). Live updates
// arrive as `plugin.slopcannon.*` gateway events; React Query polling is the
// fallback (5 s while anything renders, 30 s otherwise).

import * as sdk from '@hermes/plugin-sdk'
import { Component, createElement as h, Fragment, useEffect, useMemo, useRef, useState } from 'react'

const ID = 'slopcannon'
const ROUTE = '/slopcannon'
const TOP_UP_URL = 'https://slop.cc/account#buy-credits'
// Sign-in belongs to Hermes and runs in a terminal; the studio only shows the command.
const SIGN_IN_COMMAND = 'hermes auth add slopcannon:slop'
const PRODUCTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const FAST_POLL_MS = 5_000
const SLOW_POLL_MS = 30_000
const SESSION_MEMORY_LIMIT = 60
const FRAME_NAME = /^[a-f0-9]{24}-(poster|strip|thumb)\.jpg$/
// The driver renders up to this many scenes at once; only used to estimate time left.
const RENDER_CONCURRENCY = 4

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
  Loader,
  LogView,
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
  if (a && b) return `${a} \u2013 ${b}`
  return a || b || null
}

// Whole seconds, as a film length: 60000 -> 1:00, 45000 -> 0:45.
function fmtDur(ms) {
  if (num(ms) === null) return null
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function fmtTimeOfDay(ms) {
  if (num(ms) === null || ms <= 0) return null
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return null
  }
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

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
    second: num(o.second) ?? num(o.atSeconds),
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
    cast: arr(o.cast).filter(c => typeof c === 'string'),
    status: SCENE_STATUSES.has(o.status) ? o.status : 'unsubmitted',
    quoteCredits: int(o.quoteCredits),
    generationId: str(o.generationId),
    clip: normClip(o.clip),
    check: normCheck(o.check),
    checkAccepted: o.checkAccepted === true,
    take: int(o.take),
    submittedAt: num(o.submittedAt),
    renderedAt: num(o.renderedAt)
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
    durationMs: num(o.durationMs),
    quotedCredits: int(o.quotedCredits),
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
  detail: (scope, id) => ['slopcannon', scope, 'production', id],
  media: (scope, id) => ['slopcannon', scope, 'media', id],
  thumbs: scope => ['slopcannon', scope, 'thumbs'],
  locate: (scope, path, gid) => ['slopcannon', scope, 'locate', path || '', gid || ''],
  // Frames are immutable (the name is a content key): outside keys.all, so a
  // live production event never refetches every picture on the page.
  frame: (scope, name) => ['slopcannon-frame', scope, name]
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
  { id: 'approve', label: 'Quote' },
  { id: 'first', label: 'First scene' },
  { id: 'render', label: 'Render' },
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
  idle: { label: 'Paused', variant: 'muted' },
  running: { label: 'Rendering', variant: 'default' },
  needs: { label: 'Needs you', variant: 'warn' },
  done: { label: 'Done', variant: 'success' },
  error: { label: 'Error', variant: 'destructive' }
}

// The list chip: what the decision is, in one word.
const NEED_SHORT = {
  rights: 'Rights',
  approval: 'Approve',
  budget: 'Budget',
  first_scene_review: 'Review',
  shot_review: 'Checks',
  review: 'Review',
  new_revision: 'Revision',
  origin: 'Decide',
  recovery: 'Recover'
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
function needsModel(p, extra = {}) {
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
      const scenes = arr(d.quotes).length || (p.counts && p.counts.total) || 0
      const have = int(extra.available)
      const parts = []
      if (scenes) parts.push(plural(scenes, 'scene'))
      if (have !== null) parts.push(n !== null && have < n ? `you have ${fmtCredits(have)}, top up first` : `you have ${fmtCredits(have)}`)
      parts.push('the first scene renders and waits for your look before the rest')
      return {
        tone: 'attention',
        icon: 'credit-card',
        headline: n !== null ? `Approve ${fmtCredits(n)} Cannon Credits` : 'Approve the quote',
        body: parts.join(' \u00b7 '),
        planActions: true,
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
// every colour is a theme variable. The one literal is black behind video
// frames (letterbox), which is the film's, not the theme's.

const CSS = `
.sc-page,.sc-wrap,.sc-status{--sc-err:var(--color-destructive,var(--dt-destructive,var(--ui-red)));--sc-pop:var(--color-popover,var(--ui-bg-elevated))}
.sc-page{height:100%;min-height:0;overflow:auto;container-type:inline-size;color:var(--ui-text-primary);font-size:.8125rem;line-height:1.45}
.sc-studio{display:grid;grid-template-columns:268px minmax(0,1fr);min-height:100%}
.sc-side{display:flex;flex-direction:column;gap:14px;min-width:0;padding:18px 8px 24px 16px}
.sc-main{display:flex;flex-direction:column;gap:18px;min-width:0;max-width:1180px;padding:18px 28px 32px 20px}
@container (max-width:820px){.sc-studio{grid-template-columns:minmax(0,1fr)}.sc-side{max-height:300px;overflow:auto;padding:16px 16px 0}.sc-main{padding:12px 16px 28px}}
.sc-brandrow{display:flex;align-items:baseline;gap:12px;padding:0 8px;min-height:20px}
.sc-brand{font-size:.8125rem;font-weight:600;letter-spacing:.08em}
.sc-label{font-size:.6875rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ui-text-tertiary);margin:0}
.sc-mono{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-variant-numeric:tabular-nums}
.sc-num{font-variant-numeric:tabular-nums}
.sc-muted{color:var(--ui-text-tertiary)}
.sc-faint{color:var(--ui-text-quaternary)}
.sc-second{color:var(--ui-text-secondary)}
.sc-spacer{flex:1}
.sc-quiet{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:.75rem;color:var(--ui-text-tertiary)}
.sc-loader{display:inline-flex;width:16px;height:16px;flex:none;color:var(--ui-text-tertiary)}
.sc-loader svg{width:100%;height:100%}
.sc-group{display:flex;flex-direction:column;gap:1px;min-width:0}
.sc-group>.sc-label{padding:0 8px 6px}
.sc-prow{all:unset;box-sizing:border-box;display:grid;grid-template-columns:64px minmax(0,1fr);gap:10px;align-items:center;min-width:0;padding:6px 8px;border-radius:3px;cursor:pointer;transition:background-color .1s}
.sc-prow:hover{background:var(--ui-row-hover-background);transition:none}
.sc-prow[data-selected=true]{background:var(--ui-row-active-background)}
.sc-prow:focus-visible{outline:1px solid var(--ui-accent);outline-offset:-1px}
.sc-thumb{display:block;width:64px;aspect-ratio:16/9;border-radius:2px;overflow:hidden;background:var(--ui-bg-quaternary)}
.sc-thumb[data-ready=true]{background:black}
.sc-thumb img{display:block;width:100%;height:100%;object-fit:cover}
.sc-ptext{display:flex;flex-direction:column;gap:2px;min-width:0}
.sc-ptitle{display:block;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-pmeta{display:flex;align-items:center;gap:8px;min-width:0;font-size:.6875rem;color:var(--ui-text-tertiary);white-space:nowrap;overflow:hidden}
.sc-acct{display:flex;align-items:center;justify-content:flex-end;gap:6px 14px;flex-wrap:wrap;min-height:20px;font-size:.75rem;color:var(--ui-text-tertiary)}
.sc-acct b{color:var(--ui-text-primary);font-weight:600}
.sc-acct-item{display:inline-flex;align-items:center;gap:6px;min-width:0}
.sc-okdot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ui-green);flex:none}
.sc-warndot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ui-yellow);flex:none}
.sc-head{display:flex;align-items:flex-end;gap:10px 16px;flex-wrap:wrap}
.sc-head-text{min-width:0;flex:1 1 320px}
.sc-h1{margin:4px 0 6px;font-size:1.375rem;line-height:1.2;font-weight:600;overflow-wrap:anywhere}
.sc-meta{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:.75rem;color:var(--ui-text-tertiary)}
.sc-meta i{font-style:normal;color:var(--ui-text-quaternary)}
.sc-head-acts{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}
.sc-steps{display:flex;align-items:center;margin:0;padding:0;list-style:none;min-width:0}
.sc-step{display:flex;align-items:center;gap:6px;font-size:.6875rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ui-text-secondary);white-space:nowrap}
.sc-step .codicon{font-size:12px;color:var(--ui-accent)}
.sc-step[data-s=current]{color:var(--ui-accent)}
.sc-step[data-s=current][data-tone=error]{color:var(--sc-err)}
.sc-step[data-s=current][data-tone=paused]{color:var(--ui-text-primary)}
.sc-step[data-s=todo]{color:var(--ui-text-quaternary)}
.sc-pip{display:inline-block;width:8px;height:8px;margin:0 2px;border-radius:50%;background:currentColor;flex:none}
.sc-step[data-s=todo] .sc-pip{background:none;box-shadow:inset 0 0 0 1px currentColor}
.sc-step[data-tone=active] .sc-pip{animation:sc-pulse 1.6s ease-in-out infinite}
.sc-rule{flex:1;height:1px;min-width:10px;margin:0 10px;background:var(--ui-stroke-secondary)}
@container (max-width:900px){.sc-step[data-s=done] .sc-step-label{display:none}.sc-rule{margin:0 6px}}
@keyframes sc-pulse{50%{opacity:.35}}
.sc-decide{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 24px;padding:14px 16px;background:color-mix(in srgb,var(--ui-accent) 9%,transparent)}
.sc-decide[data-tone=error]{background:color-mix(in srgb,var(--sc-err) 9%,transparent)}
.sc-decide h2{margin:0;font-size:.875rem;font-weight:600}
.sc-decide p{margin:0;color:var(--ui-text-secondary);overflow-wrap:anywhere}
.sc-decide-acts{grid-row:1/3;grid-column:2;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
@container (max-width:700px){.sc-decide{grid-template-columns:minmax(0,1fr)}.sc-decide-acts{grid-row:auto;grid-column:auto;justify-content:flex-start;margin-top:6px}}
.sc-detail-extra{display:flex;flex-direction:column;gap:8px;min-width:0}
.sc-statement{max-height:180px;overflow:auto;white-space:pre-wrap;font-size:.75rem;line-height:1.5;color:var(--ui-text-secondary);padding:10px 0;border-top:1px solid var(--ui-stroke-tertiary)}
.sc-files{display:flex;flex-direction:column;gap:2px;font-size:.75rem;color:var(--ui-text-secondary)}
.sc-files span{display:flex;gap:6px;align-items:center}
.sc-table{display:grid;grid-template-columns:auto 1fr auto;gap:2px 14px;font-size:.75rem;align-items:baseline;max-width:360px}
.sc-cell-r{text-align:right;font-variant-numeric:tabular-nums}
.sc-flagrow{display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:1px solid var(--ui-stroke-tertiary)}
.sc-flagrow-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sc-issues{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;font-size:.75rem;color:var(--ui-text-secondary)}
.sc-issues li{display:flex;gap:6px}
.sc-film{position:relative;width:100%;max-height:60vh;overflow:hidden;background:black}
.sc-film>video,.sc-film>img{position:absolute;inset:0;display:block;width:100%;height:100%}
.sc-film>video{object-fit:contain}
.sc-film>img{object-fit:cover}
.sc-film[data-portrait=true]>img{object-fit:contain}
.sc-film[data-started=false]>video{opacity:0}
.sc-film[data-started=false][data-has-poster=false]>video{opacity:1}
.sc-stage{display:flex;justify-content:center;min-width:0;background:black;--sc-cap:clamp(220px,calc(100vh - 540px),620px)}
.sc-stage>.sc-film{flex:none;width:min(100%,calc(var(--sc-cap) * var(--sc-ar,1.7778)));max-height:none}
.sc-stage>.sc-film-fallback{flex:1;padding:12px;background:var(--ui-bg-secondary)}
.sc-posterbar{display:flex;align-items:center;justify-content:flex-end;gap:2px 8px;flex-wrap:wrap;min-height:24px;margin-top:-12px;font-size:.6875rem;color:var(--ui-text-tertiary)}
.sc-tipwrap{display:inline-flex}
.sc-film-over{position:absolute;left:16px;right:16px;bottom:14px;display:flex;align-items:center;gap:10px;pointer-events:none}
.sc-film-over>*{pointer-events:auto}
.sc-film[data-compact=true] .sc-film-over{left:12px;right:12px;bottom:10px}
.sc-ontime{margin-left:auto;padding:1px 6px;border-radius:3px;font-size:.6875rem;color:var(--ui-text-secondary);background:color-mix(in srgb,var(--sc-pop) 82%,transparent)}
.sc-probe{display:none}
.sc-wrap img,.sc-wrap video,.sc-page img,.sc-page video{margin:0;max-width:none;border-radius:0}
.sc-wrap h4,.sc-wrap p,.sc-wrap figcaption{margin:0}
.sc-tl{display:flex;flex-direction:column;gap:6px;min-width:0}
.sc-tl-head{display:flex;align-items:baseline;gap:4px 10px;flex-wrap:wrap}
.sc-tl-head .sc-mono{font-size:.6875rem;color:var(--ui-text-tertiary)}
.sc-lane{position:relative;display:flex;flex-direction:column;gap:6px}
.sc-track{display:flex;gap:2px;height:58px;min-width:0}
.sc-tl[data-compact=true] .sc-track{height:40px}
.sc-seg{all:unset;box-sizing:border-box;position:relative;flex:1 1 0;min-width:6px;display:flex;overflow:hidden;background:var(--ui-bg-quaternary)}
button.sc-seg{cursor:pointer}
.sc-seg[data-ready=true]{background:black}
.sc-seg img{flex:none;height:100%;width:auto;max-width:none;opacity:.88;transition:opacity .1s}
button.sc-seg:hover img{opacity:1;transition:none}
.sc-seg[data-selected=true]{outline:2px solid var(--ui-accent);outline-offset:2px;z-index:1}
button.sc-seg:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px;z-index:2}
.sc-seg[data-kind=plan]{background:none;box-shadow:inset 0 0 0 1px var(--ui-stroke-secondary)}
.sc-seg[data-kind=queued]{background:none;box-shadow:inset 0 0 0 1px var(--ui-stroke-tertiary)}
.sc-seg[data-kind=now]{background:none;box-shadow:inset 0 0 0 1.5px var(--ui-accent)}
.sc-seg[data-kind=failed]{background:none;box-shadow:inset 0 0 0 1.5px var(--sc-err)}
.sc-tag{position:absolute;left:4px;top:3px;padding:0 3px;border-radius:2px;font-size:.625rem;line-height:14px;font-weight:600;letter-spacing:.06em;color:var(--ui-text-primary);background:color-mix(in srgb,var(--sc-pop) 74%,transparent);white-space:nowrap}
.sc-seg[data-kind=plan] .sc-tag,.sc-seg[data-kind=queued] .sc-tag,.sc-seg[data-kind=empty] .sc-tag{background:none;color:var(--ui-text-tertiary)}
.sc-seg[data-kind=now] .sc-tag{background:none;color:var(--ui-accent)}
.sc-seg[data-kind=failed] .sc-tag{background:none;color:var(--sc-err)}
.sc-tl[data-compact=true] .sc-tag{font-size:.59375rem}
.sc-flag{position:absolute;right:3px;top:3px;display:grid;place-items:center;width:14px;height:14px;border-radius:2px;background:var(--ui-yellow);color:black;font-size:10px;font-weight:800;line-height:1}
.sc-tl[data-compact=true] .sc-flag{width:12px;height:12px;font-size:9px}
.sc-wave{display:block;width:100%;height:30px;color:var(--ui-text-tertiary);opacity:.4}
.sc-tl[data-compact=true] .sc-wave{height:20px}
.sc-ticks{position:relative;height:14px;font-size:.625rem;color:var(--ui-text-quaternary)}
.sc-ticks span{position:absolute;top:0;white-space:nowrap}
.sc-playhead{position:absolute;top:-4px;bottom:-4px;width:1px;background:var(--ui-text-primary);pointer-events:none;z-index:3}
.sc-progress{display:flex;align-items:center;gap:10px;font-size:.75rem;color:var(--ui-text-secondary)}
.sc-bar{position:relative;flex:1;min-width:40px;height:2px;background:var(--ui-stroke-tertiary)}
.sc-bar i{position:absolute;inset:0 auto 0 0;background:var(--ui-accent)}
.sc-insp{display:grid;grid-template-columns:minmax(0,420px) minmax(0,1fr);gap:22px;align-items:start}
.sc-insp[data-noclip=true]{grid-template-columns:minmax(0,1fr)}
@container (max-width:760px){.sc-insp{grid-template-columns:minmax(0,1fr)}}
.sc-h3{display:flex;align-items:baseline;gap:4px 10px;flex-wrap:wrap;margin:2px 0 4px;font-size:.9375rem;font-weight:600}
.sc-h3 .sc-mono{font-size:.75rem;font-weight:400;color:var(--ui-text-tertiary)}
.sc-facts{display:flex;gap:4px 14px;flex-wrap:wrap;margin-bottom:12px;font-size:.75rem;color:var(--ui-text-tertiary)}
.sc-verdict{display:flex;gap:10px;padding:10px 0;border-top:1px solid var(--ui-stroke-tertiary)}
.sc-verdict>.codicon{flex:none;margin-top:2px;line-height:1}
.sc-verdict b{display:block;margin-bottom:2px;font-weight:600}
.sc-verdict span{color:var(--ui-text-secondary);overflow-wrap:anywhere}
.sc-warn{color:var(--ui-yellow)}
.sc-ok{color:var(--ui-green)}
.sc-err{color:var(--sc-err)}
.sc-run{color:var(--ui-accent)}
.sc-dir{margin-bottom:10px;padding-top:10px;border-top:1px solid var(--ui-stroke-tertiary);color:var(--ui-text-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.sc-dir[data-folded=true]{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.sc-acts{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sc-insp .sc-acts{margin-top:4px}
.sc-details>summary{display:inline-flex;align-items:center;gap:4px;cursor:pointer;list-style:none;font-size:.75rem;color:var(--ui-text-tertiary)}
.sc-details>summary::-webkit-details-marker{display:none}
.sc-details>summary .codicon{transition:transform .1s}
.sc-details[open]>summary .codicon{transform:rotate(90deg)}
.sc-details>*+*{margin-top:8px}
.sc-log{max-height:240px;margin:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.6875rem;line-height:1.5;color:var(--ui-text-secondary)}
.sc-first{display:flex;flex-direction:column;gap:18px;min-width:0;padding-top:6px}
.sc-first-tl .sc-wave{opacity:.28}
.sc-first-tl .sc-seg[data-kind=plan]{box-shadow:inset 0 0 0 1px var(--ui-stroke-secondary)}
.sc-beats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin:0;padding:0;list-style:none;counter-reset:sc-beat}
.sc-beat{display:flex;flex-direction:column;gap:3px;min-width:0;padding-top:10px;border-top:1px solid var(--ui-stroke-secondary);counter-increment:sc-beat}
.sc-beat b{font-weight:600}
.sc-beat b::before{content:counter(sc-beat,decimal-leading-zero);margin-right:8px;font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:.6875rem;font-weight:600;color:var(--ui-text-quaternary)}
.sc-beat span{color:var(--ui-text-secondary);max-width:34ch}
@container (max-width:700px){.sc-beats{grid-template-columns:minmax(0,1fr);gap:12px}}
.sc-first-acts{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;padding-top:4px}
.sc-first-signin{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:.75rem;color:var(--ui-text-tertiary)}
.sc-cmd{padding:1px 6px;border-radius:3px;background:var(--ui-bg-quaternary);color:var(--ui-text-primary)}
.sc-wrap{display:flex;flex-direction:column;max-width:700px;margin:6px 0}
.sc-wcard{container-type:inline-size;overflow:hidden;border-radius:calc(var(--radius-scalar,.2) * 2rem);background:var(--ui-widget-surface-background);color:var(--ui-text-primary);font-size:.8125rem;line-height:1.45}
.sc-wc-head{display:flex;align-items:center;gap:10px;min-width:0;padding:11px 14px 10px}
.sc-wc-head>.codicon{color:var(--ui-text-tertiary)}
.sc-wc-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.sc-wc-body{display:flex;flex-direction:column;gap:8px;padding:12px 14px 13px;min-width:0}
.sc-wc-decide{display:flex;flex-direction:column;gap:2px;padding:11px 14px;background:color-mix(in srgb,var(--ui-accent) 9%,transparent)}
.sc-wc-decide[data-tone=error]{background:color-mix(in srgb,var(--sc-err) 9%,transparent)}
.sc-wc-decide b{font-weight:600}
.sc-wc-decide span{color:var(--ui-text-secondary);overflow-wrap:anywhere}
.sc-wc-acts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:8px}
.sc-wclip{display:grid;grid-template-columns:300px minmax(0,1fr)}
.sc-wclip .sc-film{max-height:none}
.sc-wclip .sc-wc-body{justify-content:center;gap:6px}
@container (max-width:520px){.sc-wclip{grid-template-columns:minmax(0,1fr)}}
.sc-h4{display:flex;align-items:baseline;gap:4px 8px;flex-wrap:wrap;margin:0;font-size:.84375rem;font-weight:600}
.sc-h4 .sc-mono{font-size:.71875rem;font-weight:400;color:var(--ui-text-tertiary)}
.sc-line{display:flex;align-items:flex-start;gap:7px;font-size:.75rem;color:var(--ui-text-secondary)}
.sc-line>.codicon{flex:none;margin-top:2px;line-height:1}
.sc-line>span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sc-status{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;height:100%;padding:0 7px;font-size:.6875rem;color:var(--ui-text-tertiary);cursor:pointer;font-variant-numeric:tabular-nums;white-space:nowrap;transition:background-color .1s,color .1s}
.sc-status:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary);transition:none}
.sc-status:focus-visible{outline:1px solid var(--ui-accent);outline-offset:-1px}
.sc-status b{font-weight:600;color:var(--ui-text-secondary)}
.sc-status-attn{color:var(--ui-accent)}
@media (prefers-reduced-motion:reduce){.sc-page *,.sc-wcard *,.sc-status{transition:none!important;animation:none!important}}
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

function Spinner({ label }) {
  if (Loader) return h('span', { className: 'sc-loader' }, h(Loader, { label: label || 'Loading', type: 'rose-curve' }))
  return h('span', { className: 'sc-loader', role: 'status', 'aria-label': label || 'Loading' }, icon('loading', { spinning: true }))
}

function Waiting({ label }) {
  return h('div', { className: 'sc-quiet' }, h(Spinner, { label }), h('span', null, label))
}

function StateBadge({ production }) {
  const meta = STATE_META[production.state] || STATE_META.idle
  let label = meta.label
  if (production.state === 'running' && production.counts.total) label = `Rendering ${production.counts.downloaded} / ${production.counts.total}`
  return h(Badge, { variant: meta.variant, size: 'default' }, label)
}

function Btn(props) {
  const { label, iconName, onClick, variant = 'ghost', size = 'sm', disabled, loading, tip, ariaLabel } = props
  const button = h(
    Button,
    {
      type: 'button',
      variant,
      size,
      disabled,
      loading,
      'aria-label': ariaLabel,
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
  return tip && Tip ? h(Tip, { label: tip }, button) : button
}

function reportError(err, fallback) {
  try {
    if (typeof host.notifyError === 'function') host.notifyError(err, fallback)
    else notify('error', fallback)
  } catch {
    // ignore
  }
}

// The meta line: "1:00 · 16:9 · 7 scenes".
function Meta({ items, className = 'sc-meta' }) {
  const parts = items.filter(Boolean)
  const out = []
  parts.forEach((x, i) => {
    if (i) out.push(h('i', { key: `d${i}`, 'aria-hidden': true }, '\u00b7'))
    out.push(h('span', { key: `m${i}` }, x))
  })
  return h('div', { className: `${className} sc-num` }, out)
}

// -----------------------------------------------------------------------------
// Frames and media from the backend

function normMediaPart(raw) {
  const o = obj(raw)
  const name = v => (typeof v === 'string' && FRAME_NAME.test(v) ? v : null)
  return {
    state: str(o.state) || 'missing',
    poster: name(o.poster),
    strip: name(o.strip),
    thumb: name(o.thumb),
    frames: int(o.frames),
    durationMs: num(o.durationMs),
    posterAtMs: num(o.posterAtMs),
    posterChosen: o.posterChosen === true
  }
}

function normMedia(raw) {
  const o = obj(raw)
  const wave = obj(o.wave)
  const scenes = {}
  for (const [sid, part] of Object.entries(obj(o.scenes))) scenes[sid] = normMediaPart(part)
  return {
    ffmpeg: o.ffmpeg !== false,
    pending: o.pending === true,
    film: normMediaPart(o.film),
    wave: {
      state: str(wave.state) || 'missing',
      peaks: arr(wave.peaks).map(v => (num(v) === null ? 0 : Math.max(0, Math.min(1, v)))),
      durationMs: num(wave.durationMs)
    },
    scenes
  }
}

function useMedia(id, running) {
  const scope = useScopeKey()
  return useQuery({
    queryKey: keys.media(scope, id || ''),
    enabled: Boolean(id),
    queryFn: async () => normMedia(await api(`/productions/${encodeURIComponent(id)}/media`)),
    refetchInterval: query => {
      const d = query && query.state ? query.state.data : null
      return d && d.pending ? 2_500 : running ? 2 * FAST_POLL_MS : 60_000
    },
    staleTime: 2_000,
    retry: 1
  })
}

function useThumbs(enabled) {
  const scope = useScopeKey()
  return useQuery({
    queryKey: keys.thumbs(scope),
    enabled,
    queryFn: async () => {
      const raw = obj(await api('/thumbs'))
      const out = {}
      for (const [pid, name] of Object.entries(obj(raw.thumbs))) out[pid] = typeof name === 'string' && FRAME_NAME.test(name) ? name : null
      return { pending: raw.pending === true, ffmpeg: raw.ffmpeg !== false, thumbs: out }
    },
    refetchInterval: query => (query && query.state && query.state.data && query.state.data.pending ? 3_000 : SLOW_POLL_MS),
    staleTime: 2_000,
    retry: 1
  })
}

function useFrameUrl(name) {
  const scope = useScopeKey()
  const ok = typeof name === 'string' && FRAME_NAME.test(name)
  const q = useQuery({
    queryKey: keys.frame(scope, ok ? name : ''),
    enabled: ok,
    queryFn: async () => {
      const url = str(obj(await api(`/frames/${encodeURIComponent(name)}`)).dataUrl)
      return url && url.startsWith('data:image/') ? url : ''
    },
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: 1
  })
  return ok && q.data ? q.data : null
}

function Frame({ name, className, alt = '' }) {
  const url = useFrameUrl(name)
  return url ? h('img', { className, src: url, alt, draggable: false, decoding: 'async' }) : null
}

// -----------------------------------------------------------------------------
// Players. A file on the backend's machine plays through Desktop's own media
// pipeline: a `MEDIA:` line rendered by the SDK's MessageTextContent resolves a
// playable source (Electron's media protocol, or a ticketed gateway stream).
// The plugin cannot mint that URL itself (ctx.rest is JSON only), so a hidden
// probe renders the line and the player reads the source from it; if the
// probe yields nothing, the built-in player is shown as it is.

function MediaProbe({ path, onSrc, visible }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    let last = null
    const read = () => {
      const v = el.querySelector('video, audio')
      const s = v ? v.getAttribute('src') || v.currentSrc : null
      if (s && s !== last) {
        last = s
        onSrc(s)
      }
    }
    read()
    let mo = null
    try {
      mo = new MutationObserver(read)
      mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
    } catch {
      mo = null
    }
    return () => mo && mo.disconnect()
  }, [path, onSrc])
  const MessageTextContent = sdk.MessageTextContent
  if (!MessageTextContent || !path) return null
  const q = path.includes('"') ? '`' : '"'
  return h(
    'div',
    { ref, className: visible ? 'sc-probe-visible' : 'sc-probe', 'aria-hidden': visible ? undefined : true },
    guard(h(MessageTextContent, { text: `MEDIA:${q}${path}${q}` }), visible ? h(RevealFallback, { path }) : null, path)
  )
}

function RevealFallback({ path }) {
  return h(
    'div',
    { className: 'sc-quiet' },
    icon('device-camera-video'),
    h('span', null, baseName(path)),
    h(Btn, { label: 'Show in folder', variant: 'ghost', size: 'xs', onClick: () => reveal(path) })
  )
}

const isPortrait = ratio => {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio || '')
  return Boolean(m && Number(m[1]) < Number(m[2]))
}

function ratioCss(ratio) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio || '')
  if (!m || Number(m[1]) < Number(m[2])) return '16 / 9' // portrait films sit pillarboxed in a landscape frame
  return `${m[1]} / ${m[2]}`
}

function ratioNum(ratio) {
  const [a, b] = ratioCss(ratio).split(' / ').map(Number)
  return a > 0 && b > 0 ? a / b : 16 / 9
}

// The studio's film: centred on a black stage whose height is capped to the window, so the scenes on the
// song and the top of the scene inspector stay in view; the frame keeps its ratio (never cropped).
function Stage({ ratio, children }) {
  return h('div', { className: 'sc-stage', style: { '--sc-ar': ratioNum(ratio).toFixed(4) } }, children)
}

// Under the finished film: which frame is the poster, and a quiet way to choose another. The choice is
// the plugin's own record (not the production's files); the chat card shows the same poster.
function PosterBar({ production, film, paused, filmApi }) {
  const [busy, setBusy] = useState(false)
  if (!production.master || !film || film.state === 'missing' || film.state === 'unavailable') return null
  const choose = async atMs => {
    setBusy(true)
    try {
      await api(`/productions/${encodeURIComponent(production.id)}/poster`, { method: 'POST', body: { atMs } })
      notify('info', atMs === null ? 'The poster is picked automatically again.' : `The poster is now the frame at ${fmtClock(atMs)}.`)
      invalidateAll()
    } finally {
      setBusy(false)
    }
  }
  const useFrame = () => {
    const t = filmApi.current && filmApi.current.timeMs()
    if (num(t) === null) return undefined
    return choose(Math.max(0, Math.round(t)))
  }
  const pending = film.state === 'pending'
  const note = pending
    ? 'Making the poster'
    : film.posterAtMs !== null
      ? `Poster ${fmtClock(film.posterAtMs)} \u00b7 ${film.posterChosen ? 'your pick' : 'picked automatically'}`
      : null
  const useBtn = h(Btn, { label: 'Use this frame as poster', iconName: 'device-camera', variant: 'ghost', size: 'xs', disabled: !paused || busy, onClick: useFrame })
  return h(
    'div',
    { className: 'sc-posterbar' },
    note ? h('span', { className: 'sc-mono' }, note) : null,
    Tip && !paused ? h(Tip, { label: 'Pause the film on the frame you want' }, h('span', { className: 'sc-tipwrap' }, useBtn)) : useBtn,
    film.posterChosen ? h(Btn, { label: 'Automatic poster', variant: 'ghost', size: 'xs', disabled: busy, onClick: () => choose(null) }) : null
  )
}

// One film or clip: the poster first, a play button and a time label on it;
// native controls once it plays. `src` (a ready URL, e.g. a tool file's) or
// `path` (a backend file) gives the video.
function Player({ path, src: givenSrc, posterName, ratio, label, onTime, onPlayState, apiRef, compact, ariaLabel }) {
  const poster = useFrameUrl(posterName)
  const [probed, setProbed] = useState(null)
  const [late, setLate] = useState(false)
  const [started, setStarted] = useState(false)
  const ref = useRef(null)
  const src = givenSrc || probed
  useEffect(() => {
    setProbed(null)
    setStarted(false)
    setLate(false)
    if (!path || givenSrc) return undefined
    const t = setTimeout(() => setLate(true), 6_000)
    return () => clearTimeout(t)
  }, [path, givenSrc])
  useEffect(() => {
    if (!apiRef) return undefined
    apiRef.current = {
      timeMs: () => (ref.current ? ref.current.currentTime * 1000 : null),
      seek: ms => {
        const v = ref.current
        if (!v) return
        try {
          v.currentTime = Math.max(0, ms / 1000)
        } catch {
          // not seekable yet
        }
      }
    }
    return () => {
      apiRef.current = null
    }
  })
  const onSrc = useMemo(() => s => setProbed(s), [])
  const play = () => {
    setStarted(true)
    const v = ref.current
    if (v) {
      try {
        const out = v.play()
        if (out && typeof out.catch === 'function') out.catch(() => {})
      } catch {
        // the native controls take over
      }
    }
  }
  if (path && !src && late) {
    return h('div', { className: 'sc-film-fallback' }, h(MediaProbe, { path, onSrc, visible: true }))
  }
  return h(
    'div',
    {
      className: 'sc-film',
      'data-compact': compact ? 'true' : 'false',
      'data-started': started ? 'true' : 'false',
      'data-has-poster': poster ? 'true' : 'false',
      'data-portrait': isPortrait(ratio) ? 'true' : 'false',
      style: { aspectRatio: ratioCss(ratio) }
    },
    poster && !started ? h('img', { src: poster, alt: '', draggable: false }) : null,
    src
      ? h('video', {
          ref,
          src,
          poster: poster || undefined,
          preload: poster ? 'none' : 'metadata',
          playsInline: true,
          controls: started,
          'aria-label': ariaLabel,
          onPlay: () => {
            setStarted(true)
            if (onPlayState) onPlayState(false)
          },
          onPause: () => onPlayState && onPlayState(true),
          onTimeUpdate: e => onTime && onTime(e.currentTarget.currentTime * 1000),
          onSeeked: e => onTime && onTime(e.currentTarget.currentTime * 1000)
        })
      : null,
    started
      ? null
      : h(
          'div',
          { className: 'sc-film-over' },
          h(Btn, {
            iconName: 'play',
            variant: 'floating',
            size: compact ? 'icon-sm' : 'icon',
            ariaLabel: ariaLabel ? `Play ${ariaLabel}` : 'Play',
            disabled: !src,
            onClick: play
          }),
          label ? h('span', { className: 'sc-ontime sc-mono' }, label) : null
        ),
    path && !givenSrc && !probed ? h(MediaProbe, { path, onSrc, visible: false }) : null
  )
}

async function reveal(path) {
  let ok = false
  try {
    ok = Boolean(CTX && (await CTX.os.revealPath(path)))
  } catch {
    ok = false
  }
  if (!ok) notify('warning', 'This file is on the Hermes machine and cannot be shown from here.')
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

const ASK_DRAFT = 'Make a music video for '

// A new chat with a started request in the composer: nothing is sent until the person finishes it.
function askForVideo() {
  try {
    if (typeof host.newChat === 'function') host.newChat()
  } catch {
    // stay in the current chat
  }
  let tries = 0
  const fill = async () => {
    tries += 1
    let ok = false
    try {
      ok = Boolean(host.composer && (await host.composer.setDraft(null, ASK_DRAFT)))
      if (ok && typeof host.composer.focus === 'function') host.composer.focus(null)
    } catch {
      ok = false
    }
    if (!ok && tries < 6) {
      if (CTX && typeof CTX.setTimeout === 'function') CTX.setTimeout(fill, 250)
      else setTimeout(fill, 250)
    }
  }
  if (CTX && typeof CTX.setTimeout === 'function') CTX.setTimeout(fill, 150)
  else setTimeout(fill, 150)
}

// -----------------------------------------------------------------------------
// Shared vocabulary: scenes on the song

function filmDuration(p) {
  if (num(p.durationMs) !== null && p.durationMs > 0) return p.durationMs
  const rows = p.rows || []
  const ends = rows.map(r => r.endMs).filter(v => num(v) !== null)
  return ends.length ? Math.max(...ends) : null
}

function segKind(row, p) {
  if (row.clip) return 'frames'
  if (row.status === 'running' || row.status === 'uncertain') return 'now'
  if (row.status === 'failed') return 'failed'
  if (row.status === 'queued') return 'queued'
  return p.state === 'running' ? 'queued' : 'plan'
}

function tickStep(totalMs) {
  const s = totalMs / 1000
  for (const step of [5, 10, 15, 30, 60, 120, 300, 600]) if (s / step <= 5) return step
  return 900
}

function Ticks({ totalMs }) {
  if (!totalMs) return null
  const step = tickStep(totalMs) * 1000
  const out = []
  for (let t = 0; t <= totalMs + 1; t += step) {
    const pct = Math.min(100, (t / totalMs) * 100)
    out.push(h('span', { key: t, style: { left: `${pct}%`, transform: `translateX(-${pct}%)` } }, fmtDur(t)))
  }
  return h('div', { className: 'sc-ticks sc-mono', 'aria-hidden': true }, out)
}

function Wave({ wave, totalMs }) {
  const peaks = wave && wave.state === 'ready' ? wave.peaks : []
  if (!peaks.length) return null
  let use = peaks
  // A song longer than the film (a cut of it): draw only the part the scenes cover.
  if (wave.durationMs && totalMs && wave.durationMs > totalMs * 1.02) use = peaks.slice(0, Math.max(2, Math.round((peaks.length * totalMs) / wave.durationMs)))
  const n = use.length
  let top = ''
  let bottom = ''
  use.forEach((v, i) => {
    const y = Math.max(0.6, v * 48)
    top += `${i ? 'L' : 'M'}${i} ${(50 - y).toFixed(1)}`
    bottom = `L${i} ${(50 + y).toFixed(1)}` + bottom
  })
  return h(
    'svg',
    { className: 'sc-wave', viewBox: `0 0 ${Math.max(1, n - 1)} 100`, preserveAspectRatio: 'none', 'aria-hidden': true, focusable: 'false' },
    h('path', { d: `${top}${bottom}Z`, fill: 'currentColor' })
  )
}

function SegStrip({ name }) {
  return h(Frame, { name })
}

function checksSummary(p) {
  const rows = p.rows || []
  const rendered = rows.filter(r => r.clip)
  const passed = rendered.filter(r => r.check && r.check.verdict === 'pass').length
  const kept = rendered.filter(r => r.check && r.check.verdict === 'fail' && r.checkAccepted).length
  const flagged = rendered.filter(r => r.check && r.check.verdict === 'fail' && !r.checkAccepted).length
  const unchecked = rendered.length - passed - kept - flagged
  return { total: rows.length, rendered: rendered.length, passed, kept, flagged, unchecked }
}

function trackSummary(p, ffmpegMissing) {
  const s = checksSummary(p)
  const parts = [plural(s.total, 'scene')]
  if (p.state === 'running' || (s.rendered && s.rendered < s.total)) parts.push(`${s.rendered} rendered`)
  if (s.passed) parts.push(`${s.passed} passed`)
  if (s.kept) parts.push(`${s.kept} accepted with a flag`)
  if (s.flagged) parts.push(`${s.flagged} flagged`)
  if (s.unchecked && p.state !== 'running') parts.push(`${s.unchecked} not checked`)
  if (ffmpegMissing) parts.push('frames need ffmpeg on the Hermes machine')
  return parts.join(' \u00b7 ')
}

function SceneTrack({ production, media, selectedId, onSelect, timeMs, compact }) {
  const p = production
  const rows = p.rows || []
  const total = filmDuration(p)
  if (!rows.length) return null
  const evenMs = total ? total / rows.length : 1
  const segs = rows.map(r => {
    const len = num(r.startMs) !== null && num(r.endMs) !== null && r.endMs > r.startMs ? r.endMs - r.startMs : evenMs
    const kind = segKind(r, p)
    const m = media && media.scenes[r.id]
    const ready = kind === 'frames' && m && m.state === 'ready' && m.strip
    const flag = r.clip && r.check && r.check.verdict === 'fail'
    const tag = r.id.toUpperCase()
    const meta = SCENE_META[r.status] || SCENE_META.unsubmitted
    const label = [`Scene ${r.index + 1}`, fmtRange(r.startMs, r.endMs), r.clip ? null : meta.label, flag ? 'check flagged' : null].filter(Boolean).join(', ')
    const props = {
      key: r.id,
      className: 'sc-seg',
      style: { flexGrow: len },
      'data-kind': kind === 'frames' && !ready ? 'empty' : kind,
      'data-ready': ready ? 'true' : 'false',
      'data-selected': selectedId === r.id ? 'true' : 'false',
      'aria-label': label
    }
    const inner = [ready ? h(SegStrip, { key: 'img', name: m.strip }) : null, h('span', { key: 'tag', className: 'sc-tag sc-mono' }, tag), flag ? h('span', { key: 'flag', className: 'sc-flag', 'aria-hidden': true }, '!') : null]
    return onSelect
      ? h('button', { ...props, type: 'button', 'aria-pressed': selectedId === r.id, onClick: () => onSelect(r.id) }, inner)
      : h('div', { ...props, role: 'img' }, inner)
  })
  const showHead = !compact
  return h(
    'div',
    { className: 'sc-tl', 'data-compact': compact ? 'true' : 'false' },
    showHead
      ? h('div', { className: 'sc-tl-head' }, h('h3', { className: 'sc-label' }, 'Scenes on the song'), h('span', { className: 'sc-mono' }, trackSummary(p, media && !media.ffmpeg)))
      : null,
    h(
      'div',
      { className: 'sc-lane' },
      h('div', { className: 'sc-track', role: onSelect ? 'group' : undefined, 'aria-label': 'Scenes on the song' }, segs),
      media ? h(Wave, { wave: media.wave, totalMs: total }) : null,
      total && timeMs > 0 ? h('span', { className: 'sc-playhead', style: { left: `${Math.min(100, (timeMs / total) * 100)}%` }, 'aria-hidden': true }) : null
    ),
    h(Ticks, { totalMs: total })
  )
}

// While rendering: which scene, how far, and (once a take has finished, so the
// figure is measured rather than guessed) about how long is left.
function progressModel(p) {
  const rows = p.rows || []
  const c = p.counts
  const now = rows.find(r => r.status === 'running' || r.status === 'uncertain') || rows.find(r => r.status === 'queued')
  const done = rows.filter(r => r.clip && r.submittedAt && r.renderedAt && r.renderedAt > r.submittedAt)
  let eta = null
  if (done.length && c.total > c.downloaded) {
    const avg = done.reduce((a, r) => a + (r.renderedAt - r.submittedAt), 0) / done.length
    const running = rows.filter(r => r.status === 'running' && r.submittedAt)
    const elapsed = running.length ? Math.max(...running.map(r => Date.now() - r.submittedAt)) : 0
    eta = Math.max(60_000, avg * Math.ceil((c.total - c.downloaded) / RENDER_CONCURRENCY) - elapsed)
  }
  return {
    label: now ? `Scene ${now.index + 1} ${now.status === 'queued' ? 'queued' : 'rendering'}` : `${c.downloaded} of ${c.total} rendered`,
    frac: c.total ? c.downloaded / c.total : 0,
    eta: eta !== null ? `about ${Math.max(1, Math.round(eta / 60_000))} min left` : `${c.downloaded} of ${c.total} rendered`
  }
}

function Progress({ production }) {
  const m = progressModel(production)
  return h(
    'div',
    { className: 'sc-progress', role: 'status' },
    h('span', null, m.label),
    h('span', { className: 'sc-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(m.frac * 100) }, h('i', { style: { width: `${Math.round(m.frac * 100)}%` } })),
    h('span', { className: 'sc-num' }, m.eta)
  )
}

function Stepper({ production }) {
  const current = phaseOf(production)
  const currentIndex = PHASES.findIndex(x => x.id === current)
  const tone =
    production.state === 'error'
      ? 'error'
      : production.needs || production.state === 'needs'
        ? 'attention'
        : production.state === 'running'
          ? 'active'
          : production.state === 'done'
            ? 'done'
            : 'paused'
  const items = []
  PHASES.forEach((phase, i) => {
    const s = (production.state === 'done' && phase.id !== 'done') || i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'todo'
    if (i > 0) items.push(h('li', { key: `r-${phase.id}`, className: 'sc-rule', 'aria-hidden': true }))
    items.push(
      h(
        'li',
        { key: phase.id, className: 'sc-step', 'data-s': s, 'data-tone': s === 'current' ? tone : undefined, 'aria-current': s === 'current' ? 'step' : undefined },
        s === 'done' ? icon('check') : s === 'current' && tone === 'error' ? icon('error') : h('span', { className: 'sc-pip', 'aria-hidden': true }),
        h('span', { className: 'sc-step-label' }, phase.label)
      )
    )
  })
  return h('ol', { className: 'sc-steps', 'aria-label': 'Production steps' }, items)
}

// -----------------------------------------------------------------------------
// Scenes: the verdict in plain words

function verdictOf(scene, p) {
  if (!scene.clip) {
    switch (scene.status) {
      case 'running':
        return { tone: 'run', icon: 'loading', spin: true, title: 'Rendering', text: 'The take arrives here when it is done.' }
      case 'queued':
        return { tone: 'run', icon: 'clock', title: 'Queued', text: 'Waiting for a render slot.' }
      case 'failed':
        return { tone: 'err', icon: 'error', title: 'The render failed', text: 'Reroll it, or ask Hermes what went wrong.' }
      case 'uncertain':
        return { tone: 'warn', icon: 'warning', title: 'Not sure the render started', text: 'Hermes can recover it without paying twice.' }
      default:
        return {
          tone: 'mute',
          icon: 'circle-large-outline',
          title: 'Not rendered yet',
          text: scene.quoteCredits !== null ? `Quoted at ${fmtCredits(scene.quoteCredits)} credits. It renders after the quote is approved.` : 'It renders after the quote is approved.'
        }
    }
  }
  const c = scene.check
  if (c && c.verdict === 'pass') return { tone: 'ok', icon: 'pass', title: 'Check passed', text: 'The character check found nothing off in this take.' }
  if (c && c.verdict === 'fail') {
    const words = c.issues.map(i => i.description).filter(Boolean)
    return {
      tone: 'warn',
      icon: 'warning',
      title: scene.checkAccepted ? 'Check flagged, you accepted it' : 'Check flagged',
      text: words.length ? words.join(' ') : 'The character check flagged this take.',
      short: `${words.length ? `Check flagged: ${words[0]}` : 'Check flagged this take.'}${scene.checkAccepted ? ' You kept it.' : ''}`,
      issues: c.issues
    }
  }
  if (c && c.error) return { tone: 'mute', icon: 'circle-slash', title: 'Not checked', text: c.error.message }
  if (p && p.state === 'running') return { tone: 'run', icon: 'loading', spin: true, title: 'Checking', text: 'The character check runs once the take arrives.' }
  return { tone: 'mute', icon: 'circle-slash', title: 'Not checked', text: 'The character check did not run on this take.' }
}

const TONE_CLASS = { ok: 'sc-ok', warn: 'sc-warn', err: 'sc-err', run: 'sc-run', mute: 'sc-muted' }

function sceneLen(scene) {
  return num(scene.startMs) !== null && num(scene.endMs) !== null && scene.endMs > scene.startMs ? scene.endMs - scene.startMs : null
}

function sceneFacts(scene) {
  const len = sceneLen(scene)
  return {
    len: len !== null ? `${(len / 1000).toFixed(1)} s` : null,
    take: scene.clip && scene.take ? `take ${scene.take}` : null,
    credits: scene.quoteCredits !== null ? `${fmtCredits(scene.quoteCredits)} credits` : null,
    rendered: scene.clip && scene.renderedAt ? `rendered ${fmtTimeOfDay(scene.renderedAt)}` : null
  }
}

function sceneActions(scene, p, send, { compact } = {}) {
  const ref = filmRef(p)
  const out = []
  const flagged = scene.clip && scene.check && scene.check.verdict === 'fail' && !scene.checkAccepted
  if (flagged && p.needs === 'shot_review') {
    out.push({ key: 'accept', label: 'Accept as rendered', variant: 'secondary', onClick: () => send(`Accept scene ${scene.id} of ${ref} as rendered.`) })
  }
  if (scene.clip || scene.status === 'failed') {
    out.push({
      key: 'reroll',
      label: scene.quoteCredits !== null ? `Reroll this scene \u00b7 ~${fmtCredits(scene.quoteCredits)} cr` : 'Reroll this scene',
      variant: compact || (flagged && p.needs === 'shot_review') ? 'ghost' : 'secondary',
      onClick: () => send(`Reroll scene ${scene.id} of ${ref}.`)
    })
  }
  if (scene.clip) out.push({ key: 'check', label: 'Check again', variant: 'ghost', onClick: () => send(`Check scene ${scene.id} of ${ref} for defects again.`) })
  return out
}

function ActionRow({ actions, className = 'sc-acts' }) {
  return h(
    'div',
    { className },
    actions.filter(Boolean).map(a => (a.node ? h(Fragment, { key: a.key }, a.node) : h(Btn, { key: a.key, label: a.label, iconName: a.iconName, variant: a.variant || 'ghost', size: 'sm', onClick: a.onClick })))
  )
}

function SceneInspector({ production, scene, media, send, hideClip }) {
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [scene.id])
  const v = verdictOf(scene, production)
  const f = sceneFacts(scene)
  const m = media && media.scenes[scene.id]
  const actions = sceneActions(scene, production, send)
  if (scene.beat) actions.push({ key: 'dir', label: open ? 'Hide direction' : 'Show direction', variant: 'ghost', onClick: () => setOpen(x => !x) })
  return h(
    'section',
    { className: 'sc-insp', 'data-noclip': scene.clip && !hideClip ? 'false' : 'true', 'aria-label': `Scene ${scene.index + 1}` },
    scene.clip && !hideClip
      ? guard(
          h(Player, { key: scene.clip.path, path: scene.clip.path, posterName: m && m.poster, ratio: production.aspectRatio, label: f.len, ariaLabel: `scene ${scene.index + 1}` }),
          h(RevealFallback, { path: scene.clip.path }),
          scene.clip.path
        )
      : null,
    h(
      'div',
      { style: { minWidth: 0 } },
      h('h3', { className: 'sc-h3' }, `Scene ${scene.index + 1}`, fmtRange(scene.startMs, scene.endMs) ? h('span', { className: 'sc-mono' }, fmtRange(scene.startMs, scene.endMs)) : null),
      h('div', { className: 'sc-facts sc-num' }, [f.len, f.take, f.credits, f.rendered].filter(Boolean).map((x, i) => h('span', { key: i }, x))),
      h(
        'div',
        { className: 'sc-verdict' },
        icon(v.icon, { className: TONE_CLASS[v.tone], spinning: v.spin }),
        h('div', { style: { minWidth: 0 } }, h('b', null, v.title), h('span', null, v.text))
      ),
      scene.beat ? h('div', { className: 'sc-dir', 'data-folded': open ? 'false' : 'true' }, scene.beat) : null,
      h(ActionRow, { actions })
    )
  )
}

function pickScene(p) {
  const rows = p.rows || []
  if (!rows.length) return null
  const flagged = rows.find(r => r.clip && r.check && r.check.verdict === 'fail' && !r.checkAccepted)
  if (flagged) return flagged.id
  if (p.state === 'running') {
    const now = rows.find(r => r.status === 'running')
    if (now) return now.id
  }
  const kept = rows.find(r => r.clip && r.check && r.check.verdict === 'fail')
  return (kept || rows[0]).id
}

// -----------------------------------------------------------------------------
// The decision (studio: actions inside, on the right; chat: actions below the card)

function decisionActions(production, model, send, { inChat } = {}) {
  const out = []
  if (model.primary) out.push({ key: 'primary', label: model.primary.label, variant: 'default', onClick: () => send(model.primary.text) })
  arr(model.secondary).forEach(s => out.push({ key: s.label, label: s.label, variant: inChat ? 'ghost' : 'secondary', onClick: () => send(s.text) }))
  if (inChat) {
    if (model.planActions) out.push({ key: 'plan', label: 'See the scene plan', onClick: () => openStudio(production.id) })
    else out.push({ key: 'studio', label: 'Open in studio', onClick: () => openStudio(production.id) })
  }
  if (model.planActions) out.push({ key: 'change', label: 'Change the plan', variant: 'ghost', onClick: () => send(`I want to change the plan for ${filmRef(production)} before approving it.`) })
  return out
}

function Decision({ production, model, send }) {
  return h(
    'div',
    { className: 'sc-decide', 'data-tone': model.tone, role: 'status' },
    h('h2', null, model.headline),
    h('p', null, model.body),
    h(ActionRow, { actions: decisionActions(production, model, send), className: 'sc-decide-acts' })
  )
}

function NeedsDetail({ production, send }) {
  const detail = obj(production.needsDetail)
  switch (production.needs) {
    case 'rights': {
      const files = arr(detail.files).map(obj)
      return h(
        'div',
        { className: 'sc-detail-extra' },
        str(detail.statement) ? h('div', { className: 'sc-statement' }, detail.statement) : null,
        files.length
          ? h(
              'div',
              { className: 'sc-files' },
              files.map((f, i) =>
                h('span', { key: `${str(f.name) || ''}-${i}` }, icon('file'), str(f.name) || 'file', fmtBytes(num(f.bytes)) ? h('span', { className: 'sc-faint sc-num' }, fmtBytes(num(f.bytes))) : null)
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
        cells.push(h('span', { key: `s${i}`, className: 'sc-mono' }, str(q.scene) || `#${i + 1}`))
        cells.push(h('span', { key: `g${i}` }))
        cells.push(h('span', { key: `c${i}`, className: 'sc-cell-r' }, `${fmtCredits(int(q.amountUnits))} cr`))
      })
      const total = needsTotalCredits(production)
      if (total !== null) {
        cells.push(h('b', { key: 'tl' }, 'Total'), h('span', { key: 'tg' }), h('b', { key: 'tc', className: 'sc-cell-r' }, `${fmtCredits(total)} cr`))
      }
      return h('details', { className: 'sc-details' }, h('summary', null, icon('chevron-right'), 'Quote by scene'), h('div', { className: 'sc-table' }, cells))
    }
    case 'shot_review': {
      const flagged = arr(detail.flagged).map(obj)
      if (!flagged.length) return null
      const ref = filmRef(production)
      return h(
        'div',
        { className: 'sc-detail-extra' },
        flagged.map((f, i) => {
          const scene = str(f.scene) || `#${i + 1}`
          const issues = arr(f.issues).map(normIssue)
          return h(
            'div',
            { key: `${scene}-${i}`, className: 'sc-flagrow' },
            h(
              'div',
              { className: 'sc-flagrow-head' },
              h('b', { className: 'sc-mono' }, scene.toUpperCase()),
              h('span', { className: 'sc-spacer' }),
              h(Btn, { label: 'Accept', variant: 'secondary', size: 'xs', onClick: () => send(`Accept scene ${scene} of ${ref} as rendered.`) }),
              h(Btn, { label: 'Reroll', variant: 'ghost', size: 'xs', onClick: () => send(`Reroll scene ${scene} of ${ref}.`) })
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
        h('span', null, iss.description || [iss.kind, iss.character].filter(Boolean).join(', ') || 'issue')
      )
    )
  )
}

// -----------------------------------------------------------------------------
// Studio: account (quiet text, top right)

const VIA_LABEL = { 'hermes sign-in': 'Signed in with Hermes', 'personal token': 'Signed in with a personal token' }

function Account({ brief } = {}) {
  const status = useStatus()
  if (status.isLoading && !status.data) return h('div', { className: 'sc-acct' }, h(Spinner, { label: 'Checking the account' }))
  if (!status.data) {
    return h('div', { className: 'sc-acct' }, h('span', null, backendDownText(status.error)), h(Btn, { label: 'Retry', variant: 'ghost', size: 'xs', onClick: invalidateAll }))
  }
  const s = status.data
  if (!s.connected) {
    // On the first run the sign-in command sits beside the first action instead (said once).
    if (brief) return h('div', { className: 'sc-acct' }, h('span', { className: 'sc-acct-item' }, h('span', { className: 'sc-warndot', 'aria-hidden': true }), 'Not signed in'))
    return h(
      'div',
      { className: 'sc-acct' },
      h('span', { className: 'sc-acct-item' }, h('b', null, 'Not signed in')),
      h('span', { className: 'sc-acct-item' }, 'Run', h('span', { className: 'sc-cmd sc-mono' }, s.signInCommand), 'in a terminal'),
      h(Btn, { label: 'Copy command', iconName: 'copy', variant: 'ghost', size: 'xs', onClick: () => signIn(s.signInCommand) })
    )
  }
  const c = s.credits
  const expiresMs = s.expiresAt ? s.expiresAt * 1000 : null
  const expired = expiresMs !== null && expiresMs <= Date.now()
  const svcDown = s.service.submissionReady === false
  const signedIn = h('span', { className: 'sc-acct-item' }, h('span', { className: expired ? 'sc-warndot' : 'sc-okdot', 'aria-hidden': true }), expired ? 'Session expired' : VIA_LABEL[s.via] || 'Signed in')
  return h(
    'div',
    { className: 'sc-acct' },
    expiresMs && !expired && Tip ? h(Tip, { label: `Session renews ${fmtWhen(expiresMs)} (${fmtWhenAbsolute(expiresMs)})` }, signedIn) : signedIn,
    svcDown ? h('span', { className: 'sc-acct-item' }, h('span', { className: 'sc-warndot', 'aria-hidden': true }), 'SLOPCANNON is not accepting renders right now') : null,
    s.node && !s.node.ok ? h('span', { className: 'sc-acct-item' }, h('span', { className: 'sc-warndot', 'aria-hidden': true }), s.node.message || 'Node.js is missing on the Hermes machine') : null,
    s.error ? h('span', { className: 'sc-acct-item' }, redact(s.error)) : null,
    c && c.available !== null
      ? h('span', { className: 'sc-acct-item sc-num' }, h('b', null, fmtCredits(c.available)), 'credits', c.reserved ? h('span', { className: 'sc-faint' }, `${fmtCredits(c.reserved)} held`) : null)
      : null,
    h(Btn, { label: 'Top up', variant: 'ghost', size: 'xs', onClick: topUp })
  )
}

// -----------------------------------------------------------------------------
// Studio: production list (grouped, with the film's own picture)

function groupOf(p) {
  if (p.state === 'error' || p.state === 'needs' || (p.needs && p.state !== 'done')) return 'needs'
  if (p.state === 'running') return 'running'
  if (p.state === 'done') return 'done'
  return 'idle'
}

const GROUPS = [
  { id: 'needs', label: 'Needs you', count: true },
  { id: 'running', label: 'Rendering', count: true },
  { id: 'done', label: 'Finished' },
  { id: 'idle', label: 'Paused' }
]

function rowChip(p) {
  if (p.state === 'error') return h(Badge, { variant: 'destructive', size: 'default' }, 'Error')
  if (groupOf(p) === 'needs') return h(Badge, { variant: 'warn', size: 'default' }, NEED_SHORT[p.needs] || 'Decide')
  if (p.state === 'running' && p.counts.total) return h(Badge, { variant: 'default', size: 'default' }, `${p.counts.downloaded} / ${p.counts.total}`)
  return null
}

function ProductionRow({ p, selected, onSelect, thumb }) {
  const dur = fmtDur(p.durationMs)
  const when = p.updatedAt ? fmtWhen(p.updatedAt) : null
  const g = groupOf(p)
  const meta = [p.counts.total ? plural(p.counts.total, 'scene') : null, dur, g === 'running' && when ? `updated ${when}` : g === 'done' || g === 'idle' ? when : null].filter(Boolean).join(' \u00b7 ')
  return h(
    'button',
    { type: 'button', className: 'sc-prow', title: p.title, 'data-selected': selected ? 'true' : 'false', 'aria-current': selected ? 'true' : undefined, onClick: () => onSelect(p.id) },
    h('span', { className: 'sc-thumb', 'data-ready': thumb ? 'true' : 'false', 'aria-hidden': true }, thumb ? h(Frame, { name: thumb }) : null),
    h('span', { className: 'sc-ptext' }, h('span', { className: 'sc-ptitle' }, p.title), h('span', { className: 'sc-pmeta' }, rowChip(p), h('span', { className: 'sc-num' }, meta)))
  )
}

function ProductionList({ list, selectedId, onSelect, thumbs }) {
  return h(
    Fragment,
    null,
    GROUPS.map(g => {
      const items = list.filter(p => groupOf(p) === g.id)
      if (!items.length) return null
      return h(
        'section',
        { key: g.id, className: 'sc-group', 'aria-label': g.label },
        h('h2', { className: 'sc-label' }, g.count ? `${g.label} \u00b7 ${items.length}` : g.label),
        items.map(p => h(ProductionRow, { key: p.id, p, selected: p.id === selectedId, onSelect, thumb: thumbs ? thumbs[p.id] : null }))
      )
    })
  )
}

// -----------------------------------------------------------------------------
// Studio: one production

function StopControl({ production, size = 'sm' }) {
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
    h(Btn, { label: 'Stop', variant: 'ghost', size, onClick: () => setOpen(true) }),
    ConfirmDialog
      ? h(ConfirmDialog, {
          open,
          onClose: () => setOpen(false),
          onConfirm: stop,
          title: `Stop ${production.title}?`,
          description:
            'This stops the local production run. Renders already submitted to SLOPCANNON may still finish, and their credits stay committed. Hermes can resume the production later.',
          confirmLabel: 'Stop production',
          destructive: true
        })
      : null
  )
}

function creditsLabel(p) {
  if (p.state === 'done' || (p.spend.committedCredits || 0) > 0) return p.spend.committedCredits ? `${fmtCredits(p.spend.committedCredits)} credits` : null
  const q = needsTotalCredits(p) ?? p.quotedCredits
  return q !== null && q !== undefined ? `quote ${fmtCredits(q)} credits` : null
}

function whenLabel(p) {
  if (!p.updatedAt) return null
  return `${p.state === 'done' ? 'finished' : 'updated'} ${fmtWhen(p.updatedAt)}`
}

function latestClip(p) {
  const rows = (p.rows || []).filter(r => r.clip)
  return rows.length ? rows[rows.length - 1] : null
}

// The film area: the finished film; while rendering, the latest take; at
// first-scene review, that scene. Nothing (no empty black box) otherwise.
function filmSubject(p) {
  if (p.master) return { kind: 'film', path: p.master.path }
  if (p.needs === 'first_scene_review') {
    const d = obj(p.needsDetail)
    const clip = normClip(d.clip)
    const row = (p.rows || []).find(r => r.id === str(d.scene)) || (p.rows || [])[0]
    if (clip) return { kind: 'first', path: clip.path, row }
  }
  if (p.state === 'running' || p.state === 'needs' || p.state === 'idle') {
    const row = latestClip(p)
    if (row && p.state === 'running') return { kind: 'latest', path: row.clip.path, row }
  }
  return null
}

function ProductionDetail({ id, summary }) {
  const q = useProduction(id)
  const status = useStatus()
  const p = q.data || summary
  const media = useMedia(p ? p.id : null, p && p.state === 'running').data || null
  const [sel, setSel] = useState(null)
  const [t, setT] = useState(0)
  const [paused, setPaused] = useState(false)
  const filmApi = useRef(null)
  if (!p) {
    if (q.isError) return h('div', { className: 'sc-quiet' }, isNotFound(q.error) ? 'This production no longer exists.' : backendDownText(q.error))
    return h(Waiting, { label: 'Opening the production' })
  }
  const send = text => sendFromStudio(p, text)
  const rows = p.rows || []
  const selected = rows.find(r => r.id === sel) || rows.find(r => r.id === pickScene(p)) || null
  const model = needsModel(p, { available: status.data && status.data.credits ? status.data.credits.available : null })
  const subject = filmSubject(p)
  let save = p.master ? savers.get(p.id) : null
  if (p.master && !save) {
    // A hot reload clears the module's savers while the cached read survives: capture one now.
    try {
      if (typeof sdk.captureGatewayFileDownload === 'function') savers.set(p.id, (save = sdk.captureGatewayFileDownload()))
    } catch {
      save = null
    }
  }
  const headActions = []
  if (p.master) {
    headActions.push({ key: 'reveal', label: 'Show in folder', variant: 'ghost', onClick: () => reveal(p.master.path) })
    if (typeof save === 'function') headActions.push({ key: 'save', label: 'Save a copy', variant: 'secondary', onClick: () => save(p.master.path, p.master.name) })
    if (p.state === 'done') headActions.push({ key: 'send', label: 'Send to chat', variant: 'default', onClick: () => send(`Show the finished film ${filmRef(p)} in this chat.`) })
  }
  if (p.state === 'running') headActions.push({ key: 'stop', node: h(StopControl, { production: p }) })
  if (p.state === 'idle' && !model) headActions.push({ key: 'resume', label: 'Continue', variant: 'secondary', onClick: () => send(`Continue ${filmRef(p)}.`) })
  const onSelect = sid => {
    setSel(sid)
    const row = rows.find(r => r.id === sid)
    if (subject && subject.kind === 'film' && row && num(row.startMs) !== null && filmApi.current) {
      filmApi.current.seek(row.startMs)
      setT(Math.max(1, row.startMs))
    }
  }
  const subjectMedia = subject && subject.row && media ? media.scenes[subject.row.id] : null
  return h(
    Fragment,
    null,
    h(
      'header',
      { className: 'sc-head' },
      h(
        'div',
        { className: 'sc-head-text' },
        h('div', { className: 'sc-label' }, 'Music video'),
        h('h1', { className: 'sc-h1' }, p.title),
        h(Meta, { items: [fmtDur(filmDuration(p)), p.aspectRatio, p.counts.total ? plural(p.counts.total, 'scene') : null, creditsLabel(p), whenLabel(p)] })
      ),
      headActions.length ? h(ActionRow, { actions: headActions, className: 'sc-head-acts' }) : null
    ),
    guard(h(Stepper, { production: p })),
    model ? guard(h(Decision, { production: p, model, send }), null, `${p.id}:${p.needs}:${p.state}`) : null,
    model ? guard(h(NeedsDetail, { production: p, send }), null, `${p.id}:${p.needs}`) : null,
    !model && p.message && p.state !== 'done' ? h('div', { className: 'sc-quiet' }, redact(p.message)) : null,
    p.state === 'running' ? h(Progress, { production: p }) : null,
    subject
      ? guard(
          h(
            Stage,
            { ratio: p.aspectRatio },
            h(Player, {
              key: subject.path,
              path: subject.path,
              posterName: subject.kind === 'film' ? media && media.film.poster : subjectMedia && subjectMedia.poster,
              ratio: p.aspectRatio,
              label: subject.kind === 'film' ? fmtDur(filmDuration(p)) : subject.kind === 'latest' ? `Latest \u00b7 scene ${subject.row.index + 1}` : `Scene ${subject.row ? subject.row.index + 1 : 1}`,
              onTime: subject.kind === 'film' ? setT : null,
              onPlayState: subject.kind === 'film' ? setPaused : null,
              apiRef: subject.kind === 'film' ? filmApi : null,
              ariaLabel: subject.kind === 'film' ? p.title : 'the latest scene'
            })
          ),
          h(RevealFallback, { path: subject.path }),
          subject.path
        )
      : null,
    subject && subject.kind === 'film' && media ? guard(h(PosterBar, { production: p, film: media.film, paused, filmApi }), null, p.id) : null,
    rows.length ? guard(h(SceneTrack, { production: p, media, selectedId: selected && selected.id, onSelect, timeMs: subject && subject.kind === 'film' ? t : 0 }), null, p.id) : null,
    !rows.length && p.counts.total ? h(Waiting, { label: 'Reading the scenes' }) : null,
    selected ? guard(h(SceneInspector, { production: p, scene: selected, media, send, hideClip: Boolean(subject && subject.row && subject.row.id === selected.id) }), null, `${p.id}:${selected.id}`) : null,
    p.log && p.log.length
      ? h(
          'details',
          { className: 'sc-details' },
          h('summary', null, icon('chevron-right'), 'Driver log'),
          LogView ? h(LogView, { className: 'sc-log' }, p.log.map(redact).join('\n')) : h('pre', { className: 'sc-log' }, p.log.map(redact).join('\n'))
        )
      : null
  )
}

function pickDefault(list) {
  if (!list.length) return null
  const needing = list.find(p => groupOf(p) === 'needs')
  if (needing) return needing.id
  const running = list.find(p => p.state === 'running')
  return (running || list[0]).id
}

// First run, in the studio's own vocabulary: the scenes-on-the-song lane as it will look, with empty
// slots over a generic waveform (no song yet, so no times and no numbers), and the three beats of how a
// production goes, each under its part of the lane.
const FIRST_RUN_SLOTS = [5, 4, 6, 3, 5, 4, 6]
const FIRST_RUN_BEATS = [
  { title: 'Your song in', body: 'Give Hermes a song file in a chat and, if you like, pictures of who or what should appear.' },
  { title: 'Scenes timed to the beat', body: 'It cuts the song into scenes on the beats and the words, and writes what each one shows.' },
  { title: 'Nothing spends until you approve', body: 'It quotes the credits first and asks. You see the first scene before the rest render.' }
]

// A made-up song shape (quiet intro, verse, chorus, break, chorus, fade), drawn faintly: no song yet.
function genericPeaks(n = 240) {
  const sections = [[0, 0.22], [0.1, 0.5], [0.34, 0.86], [0.55, 0.34], [0.64, 0.92], [0.9, 0.3], [1, 0.06]]
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const out = []
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1)
    let k = 0
    while (k < sections.length - 2 && x >= sections[k + 1][0]) k++
    const [x0, a] = sections[k]
    const [x1, b] = sections[k + 1]
    const level = a + (b - a) * Math.min(1, Math.max(0, (x - x0) / (x1 - x0)) ** 3)
    const beat = i % 4 === 0 ? 1 : 0.78
    out.push(Math.max(0.04, Math.min(1, level * beat * (0.7 + 0.3 * rand()))))
  }
  return out
}

function FirstRun() {
  const status = useStatus()
  const signedOut = Boolean(status.data && !status.data.connected)
  const command = (status.data && status.data.signInCommand) || SIGN_IN_COMMAND
  const peaks = useMemo(() => genericPeaks(), [])
  const slots = FIRST_RUN_SLOTS.map((len, i) =>
    h('div', { key: i, className: 'sc-seg', 'data-kind': 'plan', style: { flexGrow: len } }, h('span', { className: 'sc-tag sc-mono' }, `SC${String(i + 1).padStart(2, '0')}`))
  )
  return h(
    'section',
    { className: 'sc-first', 'aria-label': 'Make your first music video' },
    h(
      'header',
      { className: 'sc-head' },
      h('div', { className: 'sc-head-text' }, h('div', { className: 'sc-label' }, 'No music videos yet'), h('h1', { className: 'sc-h1' }, 'Your first music video starts in a chat'))
    ),
    h(
      'div',
      { className: 'sc-tl sc-first-tl' },
      h('div', { className: 'sc-tl-head' }, h('h3', { className: 'sc-label' }, 'Scenes on the song'), h('span', { className: 'sc-mono' }, 'your song goes here')),
      h(
        'div',
        { className: 'sc-lane', 'aria-hidden': true },
        h('div', { className: 'sc-track' }, slots),
        h(Wave, { wave: { state: 'ready', peaks, durationMs: null }, totalMs: null })
      )
    ),
    h(
      'ol',
      { className: 'sc-beats' },
      FIRST_RUN_BEATS.map((b, i) => h('li', { key: i, className: 'sc-beat' }, h('b', null, b.title), h('span', null, b.body)))
    ),
    h(
      'div',
      { className: 'sc-first-acts' },
      h(Btn, { label: 'Ask Hermes for a music video', variant: 'default', size: 'sm', onClick: askForVideo }),
      signedOut
        ? h(
            'span',
            { className: 'sc-first-signin' },
            h('span', null, 'First, sign in: run'),
            h('span', { className: 'sc-cmd sc-mono' }, command),
            h('span', null, 'in a terminal'),
            h(Btn, { label: 'Copy command', iconName: 'copy', variant: 'ghost', size: 'xs', onClick: () => signIn(command) })
          )
        : null
    )
  )
}

function StudioPage() {
  const productions = useProductions()
  const selected = useValue($selected)
  const list = productions.data || []
  const thumbs = useThumbs(list.length > 0).data
  const selectedId = selected && list.some(p => p.id === selected) ? selected : pickDefault(list)
  const select = id => {
    $selected.set(id)
    try {
      CTX && CTX.storage.set('selected', id)
    } catch {
      // ignore
    }
  }
  let side = null
  let main
  if (productions.isLoading && !productions.data) {
    main = h(Waiting, { label: 'Reading productions' })
  } else if (!productions.data) {
    main = h('div', { className: 'sc-quiet' }, backendDownText(productions.error), h(Btn, { label: 'Retry', variant: 'ghost', size: 'xs', onClick: invalidateAll }))
  } else if (!list.length) {
    main = guard(h(FirstRun))
  } else {
    const summary = list.find(p => p.id === selectedId) || null
    side = guard(h(ProductionList, { list, selectedId, onSelect: select, thumbs: thumbs ? thumbs.thumbs : null }))
    main = selectedId
      ? guard(
          h(ProductionDetail, { key: selectedId, id: selectedId, summary }),
          reset => h('div', { className: 'sc-quiet' }, 'This production could not be shown.', h(Btn, { label: 'Try again', variant: 'ghost', size: 'xs', onClick: reset })),
          selectedId
        )
      : null
  }
  return h(
    'div',
    { className: 'sc-page' },
    h(
      'div',
      { className: 'sc-studio' },
      h('aside', { className: 'sc-side', 'aria-label': 'Productions' }, h('div', { className: 'sc-brandrow' }, h('span', { className: 'sc-brand' }, 'SLOPCANNON'), h('span', { className: 'sc-label' }, 'Studio')), side),
      h('main', { className: 'sc-main' }, guard(h(Account, { brief: Boolean(productions.data && !list.length) })), main)
    )
  )
}

// -----------------------------------------------------------------------------
// Status bar: 'SLOPCANNON 443 cr · 1 rendering'

function StatusItem() {
  const status = useStatus()
  const productions = useProductions()
  if (!status.data) return null
  const s = status.data
  if (!s.connected) {
    const button = h(
      'button',
      { type: 'button', className: 'sc-status', onClick: () => openStudio(), 'aria-label': 'SLOPCANNON: not signed in. Open the studio.' },
      'SLOPCANNON',
      h('span', { className: 'sc-status-attn' }, 'sign in')
    )
    return Tip ? h(Tip, { label: `Not signed in. Run ${s.signInCommand} in a terminal.` }, button) : button
  }
  const list = productions.data || []
  const running = list.filter(p => p.state === 'running').length
  const waiting = list.filter(p => groupOf(p) === 'needs').length
  const c = s.credits
  const tipParts = []
  if (c && c.available !== null) tipParts.push(`${fmtCredits(c.available)} Cannon Credits${c.reserved ? `, ${fmtCredits(c.reserved)} held` : ''}`)
  if (running) tipParts.push(`${plural(running, 'production')} rendering`)
  if (waiting) tipParts.push(`${plural(waiting, 'production')} waiting for you`)
  tipParts.push('Open the studio')
  const tip = tipParts.join('. ')
  const button = h(
    'button',
    { type: 'button', className: 'sc-status', onClick: () => openStudio(), 'aria-label': `SLOPCANNON. ${tip}.` },
    'SLOPCANNON',
    c && c.available !== null ? h(Fragment, null, h('b', null, fmtCredits(c.available)), 'cr') : null,
    running ? h(Fragment, null, h('span', { 'aria-hidden': true }, '\u00b7'), h('b', null, `${running} rendering`)) : null,
    waiting ? h(Fragment, null, h('span', { 'aria-hidden': true }, '\u00b7'), h('span', { className: 'sc-status-attn' }, `${waiting} needs you`)) : null
  )
  return Tip ? h(Tip, { label: tip }, button) : button
}

// -----------------------------------------------------------------------------
// Transcript directive: ::slopcannon-film{id="..."} — one card, changing in place

function CardShell({ title, badge, children, actions }) {
  return h(
    'div',
    { className: 'sc-wrap' },
    h('div', { className: 'sc-wcard' }, h('div', { className: 'sc-wc-head' }, icon('device-camera-video'), h('span', { className: 'sc-wc-title' }, title), badge), children),
    actions && actions.length ? h(ActionRow, { actions, className: 'sc-wc-acts' }) : null
  )
}

function doneMeta(p) {
  const s = checksSummary(p)
  const checks = []
  if (s.passed) checks.push(`${s.passed} ${s.passed === 1 ? 'check' : 'checks'} passed`)
  if (s.kept) checks.push(`${s.kept} kept with a flag`)
  if (s.flagged) checks.push(`${s.flagged} flagged`)
  if (s.unchecked) checks.push(`${s.unchecked} not checked`)
  return [fmtDur(filmDuration(p)), p.counts.total ? plural(p.counts.total, 'scene') : null, p.spend.committedCredits ? `${fmtCredits(p.spend.committedCredits)} credits` : null, checks.join(', ') || null]
}

function FilmCard({ productionId, sessionId }) {
  useEffect(() => {
    if (sessionId) rememberSession(productionId, sessionId)
  }, [productionId, sessionId])
  const q = useProduction(productionId)
  const status = useStatus()
  const p = q.data
  const media = useMedia(p ? p.id : null, p && p.state === 'running').data || null
  if (!p) {
    return h(
      CardShell,
      { title: 'SLOPCANNON' },
      h('div', { className: 'sc-wc-body' }, q.isError ? h('div', { className: 'sc-quiet' }, isNotFound(q.error) ? 'This production is not on this machine.' : backendDownText(q.error)) : h(Waiting, { label: 'Opening the production' }))
    )
  }
  const send = text => sendFromCard(sessionId, text)
  const model = needsModel(p, { available: status.data && status.data.credits ? status.data.credits.available : null })
  const subject = filmSubject(p)
  const subjectMedia = subject && subject.row && media ? media.scenes[subject.row.id] : null
  const ref = filmRef(p)
  const player = subject
    ? guard(
        h(Player, {
          key: subject.path,
          path: subject.path,
          compact: true,
          posterName: subject.kind === 'film' ? media && media.film.poster : subjectMedia && subjectMedia.poster,
          ratio: p.aspectRatio,
          label: subject.kind === 'film' ? fmtDur(filmDuration(p)) : subject.kind === 'latest' ? `Latest \u00b7 scene ${subject.row.index + 1}` : `Scene ${subject.row ? subject.row.index + 1 : 1}`,
          ariaLabel: subject.kind === 'film' ? p.title : 'the latest scene'
        }),
        h(RevealFallback, { path: subject.path }),
        subject.path
      )
    : null
  const track = (p.rows || []).length ? guard(h(SceneTrack, { production: p, media, compact: true }), null, p.id) : null
  let body
  let actions
  if (model) {
    body = h(
      Fragment,
      null,
      player,
      h('div', { className: 'sc-wc-body' }, track, h(Meta, { items: [fmtDur(filmDuration(p)), p.counts.total ? plural(p.counts.total, 'scene') : null, p.aspectRatio, 'direction by Hermes'] })),
      h('div', { className: 'sc-wc-decide', 'data-tone': model.tone }, h('b', null, model.headline), h('span', null, model.body))
    )
    actions = decisionActions(p, model, send, { inChat: true })
  } else if (p.state === 'running') {
    body = h(Fragment, null, player, h('div', { className: 'sc-wc-body' }, track, h(Progress, { production: p })))
    actions = [{ key: 'studio', label: 'Open in studio', onClick: () => openStudio(p.id) }, { key: 'stop', node: h(StopControl, { production: p }) }]
  } else if (p.state === 'done') {
    body = h(Fragment, null, player, h('div', { className: 'sc-wc-body' }, track, h(Meta, { items: doneMeta(p) })))
    actions = [
      { key: 'studio', label: 'Open in studio', onClick: () => openStudio(p.id) },
      p.master ? { key: 'reveal', label: 'Show in folder', onClick: () => reveal(p.master.path) } : null,
      { key: 'reroll', label: 'Reroll a scene', onClick: () => send(`I want to reroll a scene of ${ref}. Ask me which one.`) }
    ]
  } else {
    body = h(
      Fragment,
      null,
      player,
      h('div', { className: 'sc-wc-body' }, track, h(Meta, { items: [fmtDur(filmDuration(p)), p.counts.total ? plural(p.counts.total, 'scene') : null, whenLabel(p)] }), p.message ? h('div', { className: 'sc-quiet' }, redact(p.message)) : null)
    )
    actions = [{ key: 'continue', label: 'Continue', variant: 'secondary', onClick: () => send(`Continue ${ref}.`) }, { key: 'studio', label: 'Open in studio', onClick: () => openStudio(p.id) }]
  }
  return h(CardShell, { title: p.title, badge: h(StateBadge, { production: p }), actions }, body)
}

function renderDirective(props) {
  const attrs = obj(props && props.attrs)
  const id = typeof attrs.id === 'string' ? attrs.id.trim() : ''
  if (!PRODUCTION_ID.test(id)) return null
  const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : null
  return guard(h(FilmCard, { productionId: id, sessionId }), null, id)
}

// -----------------------------------------------------------------------------
// Tool media renderer: this package's tools' clips, as the studio's scene card

function clipContext(toolName, args, result, file) {
  const r = obj(parseMaybeJson(result))
  const a = obj(args)
  const out = { kind: 'clip', productionId: null, title: null, needs: null, sceneId: null, generationId: null, assemblyId: null }
  const sceneArg = [a.sceneId, a.scene_id, a.scene].find(v => typeof v === 'string' && /^sc\d{1,3}$/i.test(v))
  if (sceneArg) out.sceneId = sceneArg.toLowerCase()
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

// Which production and scene a chat clip belongs to, when the tool result does not say.
function useLocate(info, file) {
  const scope = useScopeKey()
  const need = info.kind !== 'master' && !(info.productionId && info.sceneId)
  const q = useQuery({
    queryKey: keys.locate(scope, file.path, info.generationId),
    enabled: need,
    queryFn: async () => {
      const qs = new URLSearchParams()
      if (file.path) qs.set('path', file.path)
      if (info.generationId) qs.set('generationId', info.generationId)
      const r = obj(await api(`/locate?${qs.toString()}`))
      return { productionId: PRODUCTION_ID.test(r.productionId || '') ? r.productionId : null, sceneId: str(r.sceneId) }
    },
    staleTime: 60_000,
    retry: false
  })
  if (!need) return { productionId: info.productionId, sceneId: info.sceneId }
  return { productionId: info.productionId || (q.data && q.data.productionId) || null, sceneId: info.sceneId || (q.data && q.data.sceneId) || null }
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
  const where = useLocate(info, file)
  const [src, setSrc] = useState(null)
  useEffect(() => {
    let live = true
    let pr
    try {
      pr = Promise.resolve(file.resolveUrl())
    } catch (err) {
      pr = Promise.reject(err)
    }
    pr.then(
      url => live && setSrc(typeof url === 'string' && url ? url : ''),
      () => live && setSrc('')
    )
    return () => {
      live = false
    }
  }, [file])
  useEffect(() => {
    if (where.productionId && sessionId) rememberSession(where.productionId, sessionId)
  }, [where.productionId, sessionId])
  const pq = useProduction(where.productionId)
  const p = pq.data || null
  const media = useMedia(p ? p.id : null, false).data || null
  if (src === '') return fallback === undefined ? null : fallback

  const send = text => sendFromCard(sessionId, text)
  const row = p && where.sceneId ? (p.rows || []).find(r => r.id === where.sceneId) || null : null
  const ref = p ? filmRef(p) : where.productionId ? `production ${where.productionId}` : null
  const subjectText = fallbackSubject => {
    let text = where.sceneId ? `scene ${where.sceneId}` : fallbackSubject
    if (ref) text += ` of ${ref}`
    if (info.generationId) text += `, generation ${info.generationId}`
    else if (!where.sceneId && !ref) text += ` (${file.name})`
    return text
  }

  if (info.kind === 'master') {
    const actions = [
      where.productionId ? { key: 'studio', label: 'Open in studio', onClick: () => openStudio(where.productionId) } : null,
      { key: 'reveal', label: 'Show in folder', onClick: () => reveal(file.path) }
    ]
    return h(
      CardShell,
      { title: (p && p.title) || info.title || file.name, badge: h(Badge, { variant: 'success', size: 'default' }, 'Finished film'), actions },
      src ? h(Player, { src, compact: true, posterName: media && media.film.poster, ratio: p && p.aspectRatio, label: p ? fmtDur(filmDuration(p)) : null, ariaLabel: (p && p.title) || file.name }) : h('div', { className: 'sc-wc-body' }, h(Waiting, { label: 'Opening the film' })),
      p ? h('div', { className: 'sc-wc-body' }, (p.rows || []).length ? h(SceneTrack, { production: p, media, compact: true }) : null, h(Meta, { items: doneMeta(p) })) : null
    )
  }

  const m = row && media ? media.scenes[row.id] : null
  const v = row ? verdictOf(row, p) : null
  const f = row ? sceneFacts(row) : null
  const actions = []
  if (info.kind === 'first') actions.push({ key: 'continue', label: 'Looks good, continue the film', variant: 'default', onClick: () => send(`Looks good, continue the film${ref ? ` ${ref}` : ''}.`) })
  if (row && p) sceneActions(row, p, send, { compact: true }).forEach(a => actions.push(a))
  else {
    actions.push({ key: 'reroll', label: 'Reroll this scene', onClick: () => send(`Reroll ${subjectText('this scene')}.`) })
    actions.push({ key: 'check', label: 'Check again', onClick: () => send(`Check ${subjectText('this take')} for defects.`) })
  }
  if (where.productionId) actions.push({ key: 'studio', label: 'Open in studio', onClick: () => openStudio(where.productionId) })
  const title = row ? `Scene ${row.index + 1}` : where.sceneId ? `Scene ${where.sceneId.replace(/^sc0*/, '')}` : file.name
  return h(
    'figure',
    { className: 'sc-wrap', style: { marginInline: 0 } },
    h(
      'div',
      { className: 'sc-wcard sc-wclip' },
      src ? h(Player, { src, compact: true, posterName: m && m.poster, ratio: p && p.aspectRatio, label: f && f.len, ariaLabel: title }) : h('div', { className: 'sc-film', style: { aspectRatio: '16 / 9' } }),
      h(
        'figcaption',
        { className: 'sc-wc-body' },
        h('h4', { className: 'sc-h4' }, title, row && fmtRange(row.startMs, row.endMs) ? h('span', { className: 'sc-mono' }, fmtRange(row.startMs, row.endMs)) : null),
        v ? h('div', { className: 'sc-line' }, icon(v.icon, { className: TONE_CLASS[v.tone], spinning: v.spin }), h('span', null, v.short || v.title)) : null,
        info.kind === 'first' ? h('div', { className: 'sc-line' }, icon('eye', { className: 'sc-run' }), h('span', null, 'The first scene waits for your look before the rest render.')) : null,
        f ? h(Meta, { className: 'sc-meta', items: [f.take, f.credits, f.len] }) : h(Meta, { items: [p ? p.title : null, info.generationId ? 'from SLOPCANNON' : null] })
      )
    ),
    h(ActionRow, { actions, className: 'sc-wc-acts' })
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
            h('div', { className: 'sc-page' }, h('div', { className: 'sc-main' }, h('div', { className: 'sc-quiet' }, 'The SLOPCANNON studio hit an error.', h(Btn, { label: 'Reload the studio', variant: 'ghost', size: 'xs', onClick: reset }))))
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
        id: 'ask',
        area: PALETTE_AREA,
        data: {
          id: 'slopcannon.ask',
          label: 'SLOPCANNON: Ask for a music video',
          keywords: ['slopcannon', 'music video', 'new', 'make', 'song', 'film'],
          run: () => askForVideo()
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
