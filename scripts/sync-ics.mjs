/**
 * Sync HC Sibir KHL schedule → sibir.ics (Apple / Google Calendar).
 * Times from khl.ru (MSK); form/H2H/player&special-teams stats from KHL API.
 * Stats are for the current stage only (regular season or playoffs).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://khl.api.webcaster.pro/api/khl_mobile'
const KHL_CALENDAR_URL = 'https://www.khl.ru/calendar/?club=29'
const SIBIR_ID = 24
const TZ = 'Asia/Novosibirsk'
const FORM_N = 5
const DETAIL_CONCURRENCY = 10
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = join(ROOT, '.cache')
const DETAIL_CACHE_PATH = join(CACHE_DIR, 'event-details.json')

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

async function fetchTeam(teamId, stageId) {
  const data = await getJson(`/team_v2.json?id=${teamId}&stage_id=${stageId}`)
  return data.team
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

function headToHeadSeason(seasonEvents, oppId) {
  return seasonEvents
    .filter((e) => {
      const ids = new Set([e.team_a.id, e.team_b.id])
      return ids.has(SIBIR_ID) && ids.has(oppId)
    })
    .sort((a, b) => eventStartMs(a) - eventStartMs(b))
}

function h2hLines(games, season) {
  const lines = [`Все матчи ${season}:`]
  if (!games.length) {
    lines.push('в этом сезоне не играют')
    return lines
  }
  for (const g of games) {
    const home = g.team_a.id === SIBIR_ID
    const opp = opponentOf(g, SIBIR_ID)
    const matchup = home ? `Сибирь — ${opp.name}` : `${opp.name} — Сибирь`
    const mark = resultMark(g, SIBIR_ID)
    const prefix = mark ? `${mark} ` : ''
    lines.push(`${prefix}${formatRuDate(eventStartMs(g))}  ${matchup}  ${scoreLabel(g)}`)
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

function normName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/)
  if (parts.length >= 2) return `${parts[0]} ${parts[1][0]}.`
  return name
}

function isForward(roleKey) {
  return roleKey === 'forward'
}

function isDefense(roleKey) {
  return roleKey === 'defensemen' || roleKey === 'defender' || roleKey === 'defence'
}

function emptyTeamBag() {
  return {
    players: new Map(),
    ppGoals: 0,
    ppOpps: 0,
    pkGoalsAgainst: 0,
    pkOpps: 0,
  }
}

function cloneTeamBag(bag) {
  const players = new Map()
  for (const [k, v] of bag.players) players.set(k, { ...v })
  return {
    players,
    ppGoals: bag.ppGoals,
    ppOpps: bag.ppOpps,
    pkGoalsAgainst: bag.pkGoalsAgainst,
    pkOpps: bag.pkOpps,
  }
}

function ensurePlayer(bag, key, name, roleKey) {
  if (!bag.players.has(key)) {
    bag.players.set(key, { name, roleKey: roleKey || 'forward', g: 0, a: 0 })
  } else if (roleKey && bag.players.get(key).roleKey !== roleKey) {
    bag.players.get(key).roleKey = roleKey
  }
  return bag.players.get(key)
}

function loadDetailCache() {
  try {
    if (!existsSync(DETAIL_CACHE_PATH)) return {}
    return JSON.parse(readFileSync(DETAIL_CACHE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function saveDetailCache(cache) {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(DETAIL_CACHE_PATH, JSON.stringify(cache), 'utf8')
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

async function fetchEventDetails(eventIds, cache) {
  const missing = eventIds.filter((id) => !cache[id])
  if (missing.length) {
    await mapPool(missing, DETAIL_CONCURRENCY, async (id) => {
      try {
        const data = await getJson(`/event_v2.json?id=${id}`)
        const ev = data.event || data
        cache[id] = {
          id,
          goals: (ev.goals || []).map((g) => ({
            status: g.status || '',
            status_abbr: g.status_abbr || '',
            author: g.author
              ? { name: g.author.name, team_id: g.author.team_id, shirt_number: g.author.shirt_number }
              : null,
            assistants: (g.assistants || []).map((a) => ({
              name: a.name,
              team_id: a.team_id,
              shirt_number: a.shirt_number,
            })),
          })),
          violations: (ev.violations || []).map((v) => ({
            time: v.time,
            penalty_time: v.penalty_time,
            penalty_reason: v.penalty_reason,
            violator: v.violator
              ? { name: v.violator.name, team_id: v.violator.team_id || v.violator.team?.id }
              : null,
            description: v.quote?.description || '',
          })),
          team_a_id: ev.team_a?.id,
          team_b_id: ev.team_b?.id,
          team_a_name: ev.team_a?.name,
          team_b_name: ev.team_b?.name,
        }
      } catch (err) {
        console.warn(`event detail ${id}: ${err.message}`)
        cache[id] = { id, goals: [], violations: [], error: true }
      }
    })
  }
  return cache
}

function resolvePenaltyTeamId(v, teamAId, teamBId, teamAName, teamBName) {
  if (v.violator?.team_id) return v.violator.team_id
  const desc = v.description || ''
  if (teamAName && desc.includes(`(${teamAName})`)) return teamAId
  if (teamBName && desc.includes(`(${teamBName})`)) return teamBId
  return null
}

function applyGameToBag(bag, detail, teamId, rolesByTeam) {
  if (!detail || detail.error) return

  const roles = rolesByTeam.get(teamId) || new Map()

  for (const g of detail.goals || []) {
    const status = g.status || ''
    const abbr = g.status_abbr || ''
    const isPP = status.includes('большинстве') || abbr === 'бол'
    const authorTeam = g.author?.team_id
    if (isPP && authorTeam === teamId) bag.ppGoals += 1
    if (isPP && authorTeam && authorTeam !== teamId) bag.pkGoalsAgainst += 1

    if (g.author?.team_id === teamId && g.author.name) {
      const key = normName(g.author.name)
      const p = ensurePlayer(bag, key, g.author.name, roles.get(key))
      p.g += 1
    }
    for (const a of g.assistants || []) {
      if (a.team_id && a.team_id !== teamId) continue
      // assistants sometimes omit team_id; credit if author is our team
      if (!a.team_id && g.author?.team_id !== teamId) continue
      if (!a.name) continue
      const key = normName(a.name)
      const p = ensurePlayer(bag, key, a.name, roles.get(key))
      p.a += 1
    }
  }

  const byTime = new Map()
  for (const v of detail.violations || []) {
    const tid = resolvePenaltyTeamId(
      v,
      detail.team_a_id,
      detail.team_b_id,
      detail.team_a_name,
      detail.team_b_name,
    )
    if (!tid) continue
    const t = v.time ?? 0
    if (!byTime.has(t)) byTime.set(t, new Set())
    byTime.get(t).add(tid)
  }
  for (const teams of byTime.values()) {
    if (teams.size !== 1) continue // coincidental / 4-on-4
    const penalized = [...teams][0]
    if (penalized === teamId) bag.pkOpps += 1
    else bag.ppOpps += 1
  }
}

function topPlayers(bag, rolePred, metric, n = 3) {
  return [...bag.players.values()]
    .filter((p) => rolePred(p.roleKey))
    .map((p) => ({ ...p, pts: p.g + p.a, metric: metric === 'g' ? p.g : metric === 'a' ? p.a : p.g + p.a }))
    .filter((p) => p.metric > 0)
    .sort((a, b) => b.metric - a.metric || b.pts - a.pts || b.g - a.g || a.name.localeCompare(b.name, 'ru'))
    .slice(0, n)
}

function fmtTop(list, metric) {
  if (!list.length) return 'нет данных'
  return list
    .map((p, i) => {
      const val =
        metric === 'g' ? `${p.g} Г` : metric === 'a' ? `${p.a} П` : `${p.pts} О (${p.g}+${p.a})`
      return `${i + 1}) ${shortName(p.name)} — ${val}`
    })
    .join('; ')
}

function pct(num, den) {
  if (!den) return '—'
  return `${Math.round((1000 * num) / den) / 10}%`
}

function stageStatsBlock(teamName, bag, stageLabel) {
  const lines = [`${teamName} · статистика ${stageLabel} до матча:`]
  if (![...bag.players.values()].some((p) => p.g + p.a > 0) && bag.ppOpps === 0 && bag.pkOpps === 0) {
    lines.push('пока нет данных по стадии')
    return lines
  }

  lines.push('Нападающие:')
  lines.push(`  бомбардиры: ${fmtTop(topPlayers(bag, isForward, 'pts'), 'pts')}`)
  lines.push(`  снайперы: ${fmtTop(topPlayers(bag, isForward, 'g'), 'g')}`)
  lines.push(`  ассистенты: ${fmtTop(topPlayers(bag, isForward, 'a'), 'a')}`)
  lines.push('Защитники:')
  lines.push(`  бомбардиры: ${fmtTop(topPlayers(bag, isDefense, 'pts'), 'pts')}`)
  lines.push(`  снайперы: ${fmtTop(topPlayers(bag, isDefense, 'g'), 'g')}`)
  lines.push(`  ассистенты: ${fmtTop(topPlayers(bag, isDefense, 'a'), 'a')}`)
  lines.push(
    `Команда: реал. большинства ${pct(bag.ppGoals, bag.ppOpps)} (${bag.ppGoals}/${bag.ppOpps}), нейтр. меньшинства ${pct(bag.pkOpps - bag.pkGoalsAgainst, bag.pkOpps)} (${bag.pkOpps - bag.pkGoalsAgainst}/${bag.pkOpps})`,
  )
  return lines
}

function buildStageTimelines(teamIds, eventsByTeam, details, rolesByTeam) {
  const timelines = new Map()
  for (const teamId of teamIds) {
    const finished = (eventsByTeam.get(teamId) || [])
      .filter(isFinished)
      .sort((a, b) => eventStartMs(a) - eventStartMs(b))
    const bag = emptyTeamBag()
    const points = []
    for (const ev of finished) {
      const before = cloneTeamBag(bag)
      points.push({ ms: eventStartMs(ev), before })
      applyGameToBag(bag, details[ev.id], teamId, rolesByTeam)
    }
    points.push({ ms: Number.POSITIVE_INFINITY, before: cloneTeamBag(bag) })
    timelines.set(teamId, points)
  }
  return timelines
}

function statsBefore(timeline, beforeMs) {
  if (!timeline?.length) return emptyTeamBag()
  for (const p of timeline) {
    if (p.ms >= beforeMs) return p.before
  }
  return timeline[timeline.length - 1].before
}

function buildDescription(event, seasonEvents, oppPool, season, stageLabel, timelines) {
  const home = event.team_a.id === SIBIR_ID
  const opp = opponentOf(event, SIBIR_ID)
  const tbd = isTimeTbd(event) && !isFinished(event)
  const sibirForm = lastFormEntries(seasonEvents, SIBIR_ID)
  const oppForm = lastFormEntries(oppPool, opp.id)
  const h2h = headToHeadSeason(seasonEvents, opp.id)
  const beforeMs = eventStartMs(event)
  const sibirBag = statsBefore(timelines.get(SIBIR_ID), beforeMs)
  const oppBag = statsBefore(timelines.get(opp.id), beforeMs)

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
    ...formBlock(`Форма Сибири (${stageLabel})`, sibirForm),
    '',
    ...formBlock(`Форма ${opp.name} (${stageLabel})`, oppForm),
    '',
    ...h2hLines(h2h, season),
    '',
    ...stageStatsBlock('Сибирь', sibirBag, stageLabel),
    '',
    ...stageStatsBlock(opp.name, oppBag, stageLabel),
  ].join('\n')
}

function buildIcs(events, oppPools, season, stageLabel, timelines) {
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
    const desc = buildDescription(
      event,
      events,
      oppPools.get(opp.id) || [],
      season,
      stageLabel,
      timelines,
    )

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
const stageLabel = stage?.type === 'playoff' ? 'плей-офф' : 'регулярка'

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
const teamIds = [SIBIR_ID, ...oppIds]

const oppPools = new Map()
const eventsByTeam = new Map([[SIBIR_ID, seasonEvents]])
await Promise.all(
  oppIds.map(async (oppId) => {
    const evs = await fetchTeamEvents(oppId, stageId)
    oppPools.set(oppId, evs)
    eventsByTeam.set(oppId, evs)
  }),
)

const rolesByTeam = new Map()
await Promise.all(
  teamIds.map(async (teamId) => {
    try {
      const team = await fetchTeam(teamId, stageId)
      const roles = new Map()
      for (const p of team.players || []) {
        roles.set(normName(p.name), p.role_key || 'forward')
      }
      rolesByTeam.set(teamId, roles)
    } catch (err) {
      console.warn(`roster ${teamId}: ${err.message}`)
      rolesByTeam.set(teamId, new Map())
    }
  }),
)

const finishedIds = [
  ...new Set(
    [...eventsByTeam.values()]
      .flat()
      .filter(isFinished)
      .map((e) => e.id),
  ),
]
const detailCache = loadDetailCache()
await fetchEventDetails(finishedIds, detailCache)
saveDetailCache(detailCache)
console.log(`Event details cached: ${finishedIds.length} finished`)

const timelines = buildStageTimelines(teamIds, eventsByTeam, detailCache, rolesByTeam)
const ics = buildIcs(seasonEvents, oppPools, season, stageLabel, timelines)

const outPath = join(ROOT, 'sibir.ics')
writeFileSync(outPath, ics, 'utf8')
console.log(`Wrote ${seasonEvents.length} events (${season}, ${stageLabel}) → ${outPath}`)
console.log(`Website times applied: ${timesApplied}/${seasonEvents.length} (timed ${timedCount})`)
console.log(`Opponents enriched: ${oppIds.length}`)
console.log(`Timezone: ${TZ}`)
