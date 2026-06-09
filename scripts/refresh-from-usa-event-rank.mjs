#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const DATA_DIR = path.join(ROOT, "data");
const SWIMMERS_JSON = path.join(DATA_DIR, "swimmers.json");
const STATUS_JSON = path.join(DATA_DIR, "usa-event-rank-status.json");

const SECURITY_URL = "https://security-api.usaswimming.org/security";
const SISENSE_URL = "https://usaswimming.sisense.com";
const EVENT_RANK_DASHBOARD = "66d20272b96443003380a50b";
const EVENT_RANK_WIDGET = "66d20272b96443003380a50d";
const EVENT_RANK_DS = "localhost_aUSAIAAaSwimmingIAAaTimesIAAaElasticube";
const REQUEST_TIMEOUT_MS = 75000;
const REQUEST_ATTEMPTS = 3;
const ROWS_PER_EVENT = Number(process.env.EVENT_RANK_ROWS_PER_EVENT || 120);
const QUALIFYING_START = "2025-07-01";
const QUALIFYING_END = "2026-07-25";

const AGE_GROUPS = [
  { label: "10&U", from: 0, to: 10 },
  { label: "11-12", from: 11, to: 12 },
  { label: "13-14", from: 13, to: 14 },
  { label: "15-16", from: 15, to: 16 },
  { label: "17-18", from: 17, to: 18 }
];
const GENDERS = [
  { value: "M", label: "Male", usa: "Male" },
  { value: "F", label: "Female", usa: "Female" }
];
const EVENT_CODES = [
  ["50 Free", "50 FR LCM"],
  ["100 Free", "100 FR LCM"],
  ["200 Free", "200 FR LCM"],
  ["50 Back", "50 BK LCM"],
  ["100 Back", "100 BK LCM"],
  ["200 Back", "200 BK LCM"],
  ["50 Breast", "50 BR LCM"],
  ["100 Breast", "100 BR LCM"],
  ["200 Breast", "200 BR LCM"],
  ["50 Fly", "50 FL LCM"],
  ["100 Fly", "100 FL LCM"],
  ["200 Fly", "200 FL LCM"],
  ["200 IM", "200 IM LCM"],
  ["400 Free", "400 FR LCM"],
  ["400 IM", "400 IM LCM"]
];

const startedAt = new Date().toISOString();
await fs.mkdir(DATA_DIR, { recursive: true });

const token = await getSisenseToken();
const widget = await getWidget(EVENT_RANK_DASHBOARD, EVENT_RANK_WIDGET, token);
const baseColumns = widget.metadata.panels.find(p => p.name === "columns").items.map(item => ({ jaql: item.jaql }));
const rowsByGroup = {};
const swimmersByKey = new Map();

for (const ageGroup of AGE_GROUPS) {
  for (const gender of GENDERS) {
    const groupKey = `${ageGroup.label}|${gender.value}`;
    rowsByGroup[groupKey] = {};
    for (const [event, eventCode] of EVENT_CODES) {
      const rows = await getEventRankRows({ widget, token, ageGroup, gender, event, eventCode });
      rowsByGroup[groupKey][event] = rows.length;
      for (const row of rows) {
        const personKey = Number(row[12]?.data ?? row[12]?.text);
        if (!personKey) continue;
        const key = `${personKey}|${gender.value}`;
        if (!swimmersByKey.has(key)) {
          swimmersByKey.set(key, {
            name: row[2]?.text || "",
            team: row[7]?.text || "",
            age: Number(row[4]?.data ?? row[4]?.text) || ageGroup.to,
            gender: gender.value,
            applied: true,
            personKey,
            sourcePersonName: row[2]?.text || "",
            sourceClub: row[7]?.text || "",
            source: "USA Swimming Top Times / Event Rank Search",
            swims: []
          });
        }
        const swimmer = swimmersByKey.get(key);
        const swim = eventRankRowToSwim(row, event);
        const existingIndex = swimmer.swims.findIndex(s => s.event === swim.event && s.course === swim.course);
        if (existingIndex === -1 || toSeconds(swim.time) < toSeconds(swimmer.swims[existingIndex].time)) {
          if (existingIndex === -1) swimmer.swims.push(swim);
          else swimmer.swims[existingIndex] = swim;
        }
      }
      console.log(`${groupKey} ${event}: ${rows.length}`);
      await delay(80);
    }
  }
}

const swimmers = [...swimmersByKey.values()].sort((a, b) =>
  a.gender.localeCompare(b.gender) ||
  a.age - b.age ||
  a.name.localeCompare(b.name)
);

const payload = {
  source: "USA Swimming Top Times / Event Rank Search via Data Hub/Sisense",
  lastUpdated: new Date().toISOString().slice(0, 10),
  notes: [
    "Refreshed from USA Swimming Top Times / Event Rank Search.",
    `Filters: PN LSC, LCM events, ${QUALIFYING_START} through ${QUALIFYING_END}, age group, and gender.`,
    `Collected up to ${ROWS_PER_EVENT} ranked rows per event to build top-50 all-around rankings per age group and gender.`
  ],
  swimmers
};

await fs.writeFile(SWIMMERS_JSON, JSON.stringify(payload, null, 2));
await fs.writeFile(STATUS_JSON, JSON.stringify({
  checkedAt: startedAt,
  finishedAt: new Date().toISOString(),
  status: "refreshed",
  source: payload.source,
  swimmers: swimmers.length,
  rowsPerEvent: ROWS_PER_EVENT,
  groups: rowsByGroup
}, null, 2));

console.log(`USA Event Rank refresh: ${swimmers.length} unique swimmers loaded.`);

async function getSisenseToken() {
  const security = await postJson(`${SECURITY_URL}/Auth/GetSecurityInfoForSubId`, {
    subId: "Anonymous",
    sessionId: "",
    toxonomies: [804],
    scope: "",
    uIProjectName: "times-microsite-ui",
    bustCache: true,
    appName: "Data",
    deviceId: "0",
    hostId: "swims-web-client"
  });
  const requestId = String(Number(security.requestId) * 13);
  const auth = await postJson(`${SECURITY_URL}/DataHubAuth/GetSisenseAuthToken`, {
    sessionId: requestId,
    deviceId: "0",
    hostId: Buffer.from("127001").toString("base64"),
    requestUrl: "/datahub/usas/timeseventrank"
  });
  if (!auth.accessToken) throw new Error("USA Swimming did not return a Sisense access token.");
  return auth.accessToken;
}

async function getWidget(dashboardOid, widgetOid, token) {
  return getJson(`${SISENSE_URL}/api/v1/dashboards/${dashboardOid}/widgets/${widgetOid}`, token);
}

async function getEventRankRows({ widget, token, ageGroup, gender, eventCode }) {
  const metadata = [
    ...baseColumns,
    column("SeasonCalendar", "CalendarDate", "datetime", "Swim Date", "[SeasonCalendar.CalendarDate (Calendar)]"),
    scope("EventCompetitionCategory", "TypeName", "text", { equals: gender.usa }, "Gender"),
    scope("BestTimes", "AgeAtMeetKey", "numeric", { from: ageGroup.from, to: ageGroup.to }, "Age"),
    scope("SwimEvent", "CourseCode", "text", { equals: "LCM" }, "Course"),
    scope("SwimEvent", "EventCode", "text", { equals: eventCode }, "Event"),
    scope("OrgUnit", "Level3Code", "text", { equals: "PN" }, "LSC"),
    scope("SeasonCalendar", "CalendarDate", "datetime", { from: QUALIFYING_START, to: QUALIFYING_END }, "Swim Date", "[SeasonCalendar.CalendarDate (Calendar)]")
  ];
  const result = await jaql(widget.datasource, metadata, token, ROWS_PER_EVENT, 0);
  return result.values || [];
}

function eventRankRowToSwim(row, event) {
  return {
    event,
    course: "LCM",
    time: cleanTime(row[1]?.text),
    date: parseEventRankDate(row[15]?.text || row[15]?.data),
    meet: row[8]?.text || "",
    powerPoints: 0,
    standard: row[9]?.text || "",
    lsc: row[6]?.text || "",
    team: row[7]?.text || "",
    swimEventKey: Number(row[10]?.data ?? row[10]?.text) || null,
    eventCompetitionCategoryKey: Number(row[11]?.data ?? row[11]?.text) || null,
    usasSwimTimeKey: Number(row[14]?.data ?? row[14]?.text) || null
  };
}

function column(table, columnName, datatype, title = columnName, dim = `[${table}.${columnName}]`) {
  return { jaql: { table, column: columnName, dim, datatype, title } };
}

function scope(table, columnName, datatype, filter, title = columnName, dim = `[${table}.${columnName}]`) {
  return { panel: "scope", jaql: { table, column: columnName, dim, datatype, title, filter } };
}

async function jaql(datasource, metadata, token, count = 500, offset = 0) {
  return postJson(`${SISENSE_URL}/api/datasources/${EVENT_RANK_DS}/jaql`, {
    datasource,
    metadata,
    count,
    offset
  }, token);
}

function cleanTime(value) {
  return String(value || "").replace(/[a-z]+$/i, "");
}

function parseEventRankDate(value) {
  const raw = String(value || "");
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) {
    const [, month, day, year] = match;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return "";
}

function toSeconds(value) {
  if (!value) return Infinity;
  const parts = String(value).replace(/[a-z]+$/i, "").split(":").map(Number);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

async function getJson(url, token) {
  const response = await fetchWithTimeout(url, { headers: authHeaders(token) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function postJson(url, body, token) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${response.status} ${url}: ${await response.text()}`);
  return response.json();
}

async function fetchWithTimeout(url, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      lastError = error;
      if (attempt === REQUEST_ATTEMPTS) throw error;
      await delay(750 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
