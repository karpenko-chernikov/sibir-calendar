/**
 * Sync HC Sibir KHL schedule → sibir.ics (for Apple / Google Calendar).
 * Usage: node scripts/sync-ics.mjs
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://khl.api.webcaster.pro/api/khl_mobile'
const SIBIR_ID = 24
const TZ = 'Asia/Novosibirsk'

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

function pad(n) {
  return String(n).padStart(2, '0')
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
  return { get, parts }
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

/** True when KHL still has placeholder kickoff (00:00 Moscow). */
function isTimeTbd(ms) {
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

function buildIcs(events) {
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
    const start = event.start_at > 1e12 ? event.start_at : event.start_at * 1000
    const end = event.end_at
      ? event.end_at > 1e12
        ? event.end_at
        : event.end_at * 1000
      : start + 2.5 * 60 * 60 * 1000
    const home = event.team_a.id === SIBIR_ID
    const opp = home ? event.team_b : event.team_a
    const summary = home ? `Сибирь — ${opp.name}` : `${opp.name} — Сибирь`
    const tbd = isTimeTbd(start) && event.game_state_key !== 'finished'
    const desc = [
      'КХЛ',
      event.stage_name,
      home ? 'Дома' : 'В гостях',
      event.location,
      tbd ? 'Время начала ещё не объявлено' : null,
      event.game_state_key === 'finished' && event.score !== '0:0' ? `Счёт ${event.score}` : null,
    ]
      .filter(Boolean)
      .join(' · ')

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
const events = await fetchTeamEvents(SIBIR_ID, stageId)
const ics = buildIcs(events)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = join(root, 'sibir.ics')
writeFileSync(outPath, ics, 'utf8')
console.log(`Wrote ${events.length} events (${stage?.season ?? stageId}) → ${outPath}`)
console.log(`Timezone: ${TZ}`)
