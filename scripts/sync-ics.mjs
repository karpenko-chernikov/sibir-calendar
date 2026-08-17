/**
 * Sync HC Sibir KHL schedule → sibir.ics (Apple / Google Calendar).
 * Times come from khl.ru (MSK); form + H2H from the KHL mobile API.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://khl.api.webcaster.pro/api/khl_mobile'
const KHL_CALENDAR_URL = 'https://www.khl.ru/calendar/?club=29'
const SIBIR_ID = 24
const TZ = 'Asia/Novosibirsk'
const FORM_N = 5
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

const MONTHS = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return res.json()
}

async function fetchTeamEvents(teamId, stageId) {
  const all = []
  for (let page = 1; page <= 30; page++) {
    const url = new URL(`${BASE}/events_v2.json`)
    url.searchParams.append('q[team_a_or_team_b_in][]', String(teamId))
    url.searchParams.set('stage_id', String(stageId))
    url.searchParams.set('order_direction', 'asc')
    url.searchParams.set('page', String(page))
    const res = await fetch(url)
    if (!res.ok) throw new Error(`events ${res.status}`)
    const batch = (await res.json()).map((w) => w.event)
    if (!batch.length) break
    all.push(...batch)
    if (batch.length < 16) break
  }
  return all
}

function cookieName(nv) {
  return nv.split('=')[0]
}

async function fetchKhlCalendarHtml() {
  const cookies = []
  for (let i = 0; i < 8; i++) {
    const headers = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru-RU,ru;q=0.9',
    }
    if (cookies.length) headers.Cookie = cookies.join('; ')
    const res = await fetch(KHL_CALENDAR_URL, { headers, redirect: 'manual' })
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    for (const c of set) {
      const nv = c.split(';')[0]
      const name = cookieName(nv)
      const idx = cookies.findIndex((x) => cookieName(x) === name)
      if (idx >= 0) cookies[idx] = nv
      else cookies.push(nv)
    }
    if (res.status >= 300 && res.status < 400) continue
    if (!res.ok) throw new Error(`khl.ru calendar ${res.status}`)
    return res.text()
  }
  throw new Error('khl.ru calendar: cookie handshake failed')
}

function parseKhlWebsiteGames(html) {
  const items = html.split('class="calendary-body__item ')
  const games = []
  for (const item of items.slice(1)) {
    const dateM = item.match(/calendary-body__wrap-time[^>]*>\s*(\d{1,2})\s+(\S+)\s+(\d{4})/)
    const timeM = item.match(/card-game__center-time[^>]*>\s*(\d{1,2}):(\d{2})/)
    const idM = item.match(/\/game\/\d+\/(\d+)\//)
    const names = [...item.matchAll(/card-game__club-name[^>]*>\s*([^<]+)/g)].map((m) => m[1].trim())
    if (!dateM || !timeM || names.length < 2 || !idM) continue
    const month = MONTHS[dateM[2]]
    if (!month) continue
    games.push({
      khlId: Number(idM[1]),
      y: Number(dateM[3]),
      m: month,
      d: Number(dateM[1]),
      hh: Number(timeM[1]),
      mm: Number(timeM[2]),
    })
  }
  return games
}

/** KHL website times are Moscow (UTC+3, no DST). */
function mskWallToUtcMs(y, m, d, hh, mm) {
  return Date.UTC(y, m - 1, d, hh - 3, mm, 0)
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function eventStartMs(event) {
  if (event._startMs) return event._startMs
  return event.start_at > 1e12 ? event.start_at : event.start_at * 1000
}

function formatUtcStamp(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

function formatInTz(ms, tz, opts) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    ...opts,
  }).formatToParts(new Date(ms))
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00'
  return { get }
}

function localDate(ms) {
  const { get } = formatInTz(ms, TZ, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return `${get('year')}${get('month')}${get('day')}`
}

function localDateTime(ms) {
  const { get } = formatInTz(ms, TZ, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  return `${get('year')}${get('month')}${get('day')}T${get('hour')}${get('minute')}${get('second')}`
}

function formatRuDate(ms) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(ms))
}

function isTimeTbd(event) {
  if (event._hasWebsiteTime) return false
  const ms = eventStartMs(event)
  const { get } = formatInTz(ms, 'Europe/Moscow', {
    hour: '2-digit',
    minute: '2-digit',
  })
  return get('hour') === '00' && get('minute') === '00'
}

function escapeText(value) {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

function fold(line) {
  if (line.length <= 75) return line
  const chunks = [line.slice(0, 75)]
  let rest = line.slice(75)
  while (rest.length) {
    chunks.push(` ${rest.slice(0, 74)}`)
    rest = rest.slice(74)
  }
  return chunks.join('\r\n')
}

function nextLocalDate(yyyymmdd) {
  const y = Number(yyyymmdd.slice(0, 4))
  const m = Number(yyyymmdd.slice(4, 6))
  const d = Number(yyyymmdd.slice(6, 8))
  const dt = new Date(Date.UTC(y, m - 1, d + 1))
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`
}

function isFinished(event) {
  return event.game_state_key === 'finished'
}

function parseScore(score) {
  const m = /^(\d+)\s*:\s*(\d+)$/.exec(String(score || '').trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2])]
}

function resultMark(event, teamId) {
  if (!isFinished(event)) return null
  const parsed = parseScore(event.score)
  if (!parsed) return null
  const [a, b] = parsed
  const isA = event.team_a.id === teamId
  const isB = event.team_b.id === teamId
  if (!isA && !isB) return null
  const teamGoals = isA ? a : b
  const oppGoals = isA ? b : a
  if (teamGoals === oppGoals) return null
  return teamGoals > oppGoals ? '🟢' : '🔴'
}

function scoreLabel(event) {
  if (!isFinished(event)) return '-:-'
  const ot = event.scores?.overtime && event.scores.overtime !== '0:0'
  const so = event.scores?.bullitt && event.scores.bullitt !== '0:0'
  const suffix = so ? ' (Б)' : ot ? ' (ОТ)' : ''
  return `${event.score || '-:-'}${suffix}`
}

function opponentOf(event, teamId) {
  return event.team_a.id === teamId ? event.team_b : event.team_a
}

function teamNameOf(event, teamId) {
  return event.team_a.id === teamId ? event.team_a.name : event.team_b.name
}

function lastFormEntries(events, teamId, n = FORM_N) {
  const played = events
    .filter(isFinished)
    .sort((a, b) => eventStartMs(b) - eventStartMs(a))
    .map((e) => {
      const mark = resultMark(e, teamId)
      if (!mark) return null
      const name = teamNameOf(e, teamId)
      const opp = opponentOf(e, teamId)
      const home = e.team_a.id === teamId
      const matchup = home ? `${name} — ${opp.name}` : `${opp.name} — ${name}`
      return {
        mark,
        line: `${mark} ${formatRuDate(eventStartMs(e))}  ${matchup}  ${scoreLabel(e)}`,
      }
    })
    .filter(Boolean)
    .slice(0, n)
    .reverse()

  const missing = n - played.length
  return [
    ...Array.from({ length: missing }, () => ({ mark: '⚪', line: '⚪ ещё не сыграно' })),
    ...played,
  ]
}

function formBlock(title, entries) {
  const dots = entries.map((e) => e.mark).join(' ')
  const played = entries.filter((e) => e.mark !== '⚪')
  const lines = [`${title}: ${dots}`]
  if (!played.length) {
    lines.push('ещё нет сыгранных матчей')
    return lines
  }
  lines.push(...played.map((e) => e.line))
  return lines
}

function headToHeadPlayed(seasonEvents, oppId) {
  return seasonEvents
    .filter((e) => {
      const ids = new Set([e.team_a.id, e.team_b.id])
      return ids.has(SIBIR_ID) && ids.has(oppId) && isFinished(e)
    })
    .sort((a, b) => eventStartMs(a) - eventStartMs(b))
}

function h2hLines(games, season) {
  const lines = [`Личные встречи ${season}:`]
  if (!games.length) {
    lines.push('пока нет сыгранных матчей')
    return lines
  }
  for (const g of games) {
    const home = g.team_a.id === SIBIR_ID
    const opp = opponentOf(g, SIBIR_ID)
    const matchup = home ? `Сибирь — ${opp.name}` : `${opp.name} — Сибирь`
    lines.push(`${formatRuDate(eventStartMs(g))}  ${matchup}  ${scoreLabel(g)}`)
  }
  return lines
}

function applyWebsiteTimes(events, websiteGames) {
  const byId = new Map(websiteGames.map((g) => [g.khlId, g]))
  let applied = 0
  for (const event of events) {
    const g = byId.get(event.khl_id)
    if (!g) continue
    event._startMs = mskWallToUtcMs(g.y, g.m, g.d, g.hh, g.mm)
    event._hasWebsiteTime = true
    applied++
  }
  return applied
}

function buildDescription(event, seasonEvents, oppPool, season) {
  const home = event.team_a.id === SIBIR_ID
  const opp = opponentOf(event, SIBIR_ID)
  const tbd = isTimeTbd(event) && !isFinished(event)
  const sibirForm = lastFormEntries(seasonEvents, SIBIR_ID)
  const oppForm = lastFormEntries(oppPool, opp.id)
  const h2h = headToHeadPlayed(seasonEvents, opp.id)

  const header = [
    'КХЛ',
    event.stage_name,
    home ? 'Дома' : 'В гостях',
    event.location,
    tbd ? 'Время начала ещё не объявлено' : null,
    isFinished(event) ? `Счёт ${scoreLabel(event)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return [
    header,
    '',
    ...formBlock('Форма Сибири (этот сезон)', sibirForm),
    '',
    ...formBlock(`Форма ${opp.name} (этот сезон)`, oppForm),
    '',
    ...h2hLines(h2h, season),
  ].join('\n')
}

function buildIcs(events, oppPools, season) {
  const now = formatUtcStamp(Date.now())
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HC Sibir Calendar//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:ХК Сибирь',
    `X-WR-TIMEZONE:${TZ}`,
    'BEGIN:VTIMEZONE',
    `TZID:${TZ}`,
    'X-LIC-LOCATION:Asia/Novosibirsk',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0700',
    'TZOFFSETTO:+0700',
    'TZNAME:+07',
    'DTSTART:19700101T000000',
    'END:STANDARD',
    'END:VTIMEZONE',
  ]

  for (const event of events) {
    const start = eventStartMs(event)
    const end = event._hasWebsiteTime
      ? start + 2.5 * 60 * 60 * 1000
      : event.end_at
        ? event.end_at > 1e12
          ? event.end_at
          : event.end_at * 1000
        : start + 2.5 * 60 * 60 * 1000
    const home = event.team_a.id === SIBIR_ID
    const opp = opponentOf(event, SIBIR_ID)
    const summary = home ? `Сибирь — ${opp.name}` : `${opp.name} — Сибирь`
    const tbd = isTimeTbd(event) && !isFinished(event)
    const desc = buildDescription(event, events, oppPools.get(opp.id) || [], season)

    lines.push('BEGIN:VEVENT', `UID:sibir-${event.id}@hcsibir-calendar`, `DTSTAMP:${now}`)

    if (tbd) {
      const day = localDate(start)
      lines.push(`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${nextLocalDate(day)}`)
    } else {
      lines.push(
        `DTSTART;TZID=${TZ}:${localDateTime(start)}`,
        `DTEND;TZID=${TZ}:${localDateTime(end)}`,
      )
    }

    lines.push(
      fold(`SUMMARY:${escapeText(summary)}`),
      fold(`DESCRIPTION:${escapeText(desc)}`),
      fold(`LOCATION:${escapeText(event.location || opp.location || '')}`),
      'END:VEVENT',
    )
  }

  lines.push('END:VCALENDAR')
  return `${lines.join('\r\n')}\r\n`
}

const data = await getJson('/data.json')
const stageId = data.current_stage_id
const stage = data.stages_v2.find((s) => s.id === stageId)
const season = stage?.season ?? String(stageId)

const seasonEvents = await fetchTeamEvents(SIBIR_ID, stageId)

let websiteGames = []
try {
  const html = await fetchKhlCalendarHtml()
  websiteGames = parseKhlWebsiteGames(html)
} catch (err) {
  console.warn(`Website times skipped: ${err.message}`)
}

const timesApplied = applyWebsiteTimes(seasonEvents, websiteGames)
const timedCount = seasonEvents.filter((e) => e._hasWebsiteTime).length

const oppIds = [...new Set(seasonEvents.map((e) => opponentOf(e, SIBIR_ID).id))]
const oppPools = new Map()
await Promise.all(
  oppIds.map(async (oppId) => {
    oppPools.set(oppId, await fetchTeamEvents(oppId, stageId))
  }),
)

const ics = buildIcs(seasonEvents, oppPools, season)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = join(root, 'sibir.ics')
writeFileSync(outPath, ics, 'utf8')
console.log(`Wrote ${seasonEvents.length} events (${season}) → ${outPath}`)
console.log(`Website times applied: ${timesApplied}/${seasonEvents.length} (timed ${timedCount})`)
console.log(`Opponents enriched: ${oppIds.length}`)
console.log(`Timezone: ${TZ}`)
