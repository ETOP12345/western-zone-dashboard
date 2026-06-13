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
const PERSON_DASHBOARD = "66034c9773fdb1003f76559e";
const PERSON_WIDGET = "66034c9f73fdb1003f7655a0";
const PERSON_DS = "localhost_aPublicIAAaPersonIAAaSearch";
const REQUEST_TIMEOUT_MS = 75000;
const REQUEST_ATTEMPTS = 3;
const ROWS_PER_EVENT = Number(process.env.EVENT_RANK_ROWS_PER_EVENT || 120);
const SCY_ROWS_PER_EVENT = Number(process.env.EVENT_RANK_SCY_ROWS_PER_EVENT || 250);
const PERSON_ROWS_PER_PAGE = 500;
const POWER_POINT_KEY_BATCH_SIZE = 500;
const POWER_POINT_MIN_BATCH_SIZE = 25;
const POWER_POINT_BATCH_ATTEMPTS = 4;
const QUALIFYING_START = "2025-07-01";
const ZONE_QUALIFYING_END = "2026-07-25";
const TODAY = new Date().toISOString().slice(0, 10);
const QUALIFYING_END = minIsoDate(ZONE_QUALIFYING_END, TODAY);

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
const EVENT_QUERIES = [
  ["50 Free", "LCM", "50 FR LCM", ROWS_PER_EVENT],
  ["100 Free", "LCM", "100 FR LCM", ROWS_PER_EVENT],
  ["200 Free", "LCM", "200 FR LCM", ROWS_PER_EVENT],
  ["50 Back", "LCM", "50 BK LCM", ROWS_PER_EVENT],
  ["100 Back", "LCM", "100 BK LCM", ROWS_PER_EVENT],
  ["200 Back", "LCM", "200 BK LCM", ROWS_PER_EVENT],
  ["50 Breast", "LCM", "50 BR LCM", ROWS_PER_EVENT],
  ["100 Breast", "LCM", "100 BR LCM", ROWS_PER_EVENT],
  ["200 Breast", "LCM", "200 BR LCM", ROWS_PER_EVENT],
  ["50 Fly", "LCM", "50 FL LCM", ROWS_PER_EVENT],
  ["100 Fly", "LCM", "100 FL LCM", ROWS_PER_EVENT],
  ["200 Fly", "LCM", "200 FL LCM", ROWS_PER_EVENT],
  ["200 IM", "LCM", "200 IM LCM", ROWS_PER_EVENT],
  ["400 Free", "LCM", "400 FR LCM", ROWS_PER_EVENT],
  ["400 IM", "LCM", "400 IM LCM", ROWS_PER_EVENT],
  ["50 Free", "SCY", "50 FR SCY", SCY_ROWS_PER_EVENT],
  ["100 Free", "SCY", "100 FR SCY", SCY_ROWS_PER_EVENT],
  ["200 Free", "SCY", "200 FR SCY", SCY_ROWS_PER_EVENT],
  ["500 Free", "SCY", "500 FR SCY", SCY_ROWS_PER_EVENT],
  ["50 Back", "SCY", "50 BK SCY", SCY_ROWS_PER_EVENT],
  ["100 Back", "SCY", "100 BK SCY", SCY_ROWS_PER_EVENT],
  ["200 Back", "SCY", "200 BK SCY", SCY_ROWS_PER_EVENT],
  ["50 Breast", "SCY", "50 BR SCY", SCY_ROWS_PER_EVENT],
  ["100 Breast", "SCY", "100 BR SCY", SCY_ROWS_PER_EVENT],
  ["200 Breast", "SCY", "200 BR SCY", SCY_ROWS_PER_EVENT],
  ["50 Fly", "SCY", "50 FL SCY", SCY_ROWS_PER_EVENT],
  ["100 Fly", "SCY", "100 FL SCY", SCY_ROWS_PER_EVENT],
  ["200 Fly", "SCY", "200 FL SCY", SCY_ROWS_PER_EVENT],
  ["100 IM", "SCY", "100 IM SCY", SCY_ROWS_PER_EVENT],
  ["200 IM", "SCY", "200 IM SCY", SCY_ROWS_PER_EVENT],
  ["400 IM", "SCY", "400 IM SCY", SCY_ROWS_PER_EVENT]
];

const startedAt = new Date().toISOString();
await fs.mkdir(DATA_DIR, { recursive: true });

const token = await getSisenseToken();
const widget = await getWidget(EVENT_RANK_DASHBOARD, EVENT_RANK_WIDGET, token);
const baseColumns = widget.metadata.panels.find(p => p.name === "columns").items.map(item => ({ jaql: item.jaql }));
const currentAges = await getCurrentAges(token);
const rowsByGroup = {};
const swimmersByKey = new Map();

for (const ageGroup of AGE_GROUPS) {
  for (const gender of GENDERS) {
    const groupKey = `${ageGroup.label}|${gender.value}`;
    rowsByGroup[groupKey] = {};
    for (const [event, course, eventCode, rowLimit] of EVENT_QUERIES) {
      const rows = await getEventRankRows({ widget, token, ageGroup, gender, eventCode, course, rowLimit });
      rowsByGroup[groupKey][`${course} ${event}`] = rows.length;
      for (const row of rows) {
        const personKey = Number(row[12]?.data ?? row[12]?.text);
        if (!personKey) continue;
        const person = currentAges.get(personKey);
        const ageAtMeet = Number(row[4]?.data ?? row[4]?.text) || null;
        const currentAge = inferredCurrentAge(person?.age, ageAtMeet, ageGroup.to);
        const key = `${personKey}|${gender.value}`;
        if (!swimmersByKey.has(key)) {
          swimmersByKey.set(key, {
            name: person?.name || row[2]?.text || "",
            team: row[7]?.text || person?.team || "",
            age: currentAge,
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
        swimmer.age = Math.max(Number(swimmer.age) || 0, currentAge);
        if (!swimmer.team && person?.team) swimmer.team = person.team;
        const swim = eventRankRowToSwim(row, event, course, ageAtMeet);
        const existingIndex = swimmer.swims.findIndex(s => s.event === swim.event && s.course === swim.course);
        if (existingIndex === -1 || toSeconds(swim.time) < toSeconds(swimmer.swims[existingIndex].time)) {
          if (existingIndex === -1) swimmer.swims.push(swim);
          else swimmer.swims[existingIndex] = swim;
        }
      }
      console.log(`${groupKey} ${course} ${event}: ${rows.length}`);
      await delay(80);
    }
  }
}

const swimmers = [...swimmersByKey.values()].sort((a, b) =>
  a.gender.localeCompare(b.gender) ||
  a.age - b.age ||
  a.name.localeCompare(b.name)
);
const powerPointStats = await hydratePowerPoints(swimmers, widget.datasource, token);

const payload = {
  source: "USA Swimming Top Times / Event Rank Search via Data Hub/Sisense",
  lastUpdated: new Date().toISOString(),
  notes: [
    "Refreshed from USA Swimming Top Times / Event Rank Search.",
    `Filters: PN LSC, LCM ranking events and SCY tie-break events, ${QUALIFYING_START} through ${QUALIFYING_END}, age-at-meet group, and gender.`,
    "Dashboard age groups use current swimmer ages from USA Swimming Person Search, not age at meet.",
    `Power points loaded from USA Swimming UsasSwimTime.PowerPoints for ${powerPointStats.resolved} of ${powerPointStats.total} swim-time keys.`,
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
  scyRowsPerEvent: SCY_ROWS_PER_EVENT,
  powerPoints: powerPointStats,
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

async function getCurrentAges(token) {
  const widget = await getWidget(PERSON_DASHBOARD, PERSON_WIDGET, token);
  const columns = widget.metadata.panels.find(p => p.name === "columns").items.map(item => ({ jaql: item.jaql }));
  const metadata = [
    ...columns,
    scope("Persons", "LscCode", "text", { equals: "PN" }, "LSC"),
    scope("Persons", "Age", "numeric", { from: 0, to: 18 }, "Age")
  ];
  const people = new Map();
  for (let offset = 0; ; offset += PERSON_ROWS_PER_PAGE) {
    const result = await jaql(PERSON_DS, widget.datasource, metadata, token, PERSON_ROWS_PER_PAGE, offset);
    const rows = result.values || [];
    for (const row of rows) {
      const personKey = Number(row[4]?.data ?? row[4]?.text);
      if (!personKey) continue;
      people.set(personKey, {
        name: row[0]?.text || "",
        team: row[1]?.text || "",
        lsc: row[2]?.text || "",
        age: Number(row[3]?.data ?? row[3]?.text) || null
      });
    }
    if (rows.length < PERSON_ROWS_PER_PAGE) break;
    await delay(80);
  }
  console.log(`Loaded ${people.size} PN swimmer current ages from USA Swimming Person Search.`);
  return people;
}

async function getEventRankRows({ widget, token, ageGroup, gender, eventCode, course, rowLimit }) {
  const metadata = [
    ...baseColumns,
    column("SeasonCalendar", "CalendarDate", "datetime", "Swim Date", "[SeasonCalendar.CalendarDate (Calendar)]"),
    scope("EventCompetitionCategory", "TypeName", "text", { equals: gender.usa }, "Gender"),
    scope("BestTimes", "AgeAtMeetKey", "numeric", { from: ageGroup.from, to: ageGroup.to }, "Age"),
    scope("SwimEvent", "CourseCode", "text", { equals: course }, "Course"),
    scope("SwimEvent", "EventCode", "text", { equals: eventCode }, "Event"),
    scope("OrgUnit", "Level3Code", "text", { equals: "PN" }, "LSC"),
    scope("SeasonCalendar", "CalendarDate", "datetime", { from: QUALIFYING_START, to: QUALIFYING_END }, "Swim Date", "[SeasonCalendar.CalendarDate (Calendar)]")
  ];
  const result = await jaql(EVENT_RANK_DS, widget.datasource, metadata, token, rowLimit, 0);
  return result.values || [];
}

function eventRankRowToSwim(row, event, course, ageAtMeet) {
  return {
    event,
    course,
    time: cleanTime(row[1]?.text),
    date: parseEventRankDate(row[15]?.text || row[15]?.data),
    meet: row[8]?.text || "",
    powerPoints: 0,
    standard: row[9]?.text || "",
    lsc: row[6]?.text || "",
    team: row[7]?.text || "",
    swimEventKey: Number(row[10]?.data ?? row[10]?.text) || null,
    eventCompetitionCategoryKey: Number(row[11]?.data ?? row[11]?.text) || null,
    usasSwimTimeKey: Number(row[14]?.data ?? row[14]?.text) || null,
    ageAtMeet
  };
}

async function hydratePowerPoints(swimmers, datasource, token) {
  const keySet = new Set();
  for (const swimmer of swimmers) {
    for (const swim of swimmer.swims || []) {
      if (swim.usasSwimTimeKey) keySet.add(Number(swim.usasSwimTimeKey));
    }
  }
  const keys = [...keySet];
  const points = new Map();
  for (let index = 0; index < keys.length; index += POWER_POINT_KEY_BATCH_SIZE) {
    const batch = keys.slice(index, index + POWER_POINT_KEY_BATCH_SIZE);
    await loadPowerPointBatch({ batch, datasource, token, points });
    console.log(`Power points: ${Math.min(index + batch.length, keys.length)}/${keys.length} keys checked`);
    await delay(80);
  }
  let assigned = 0;
  for (const swimmer of swimmers) {
    for (const swim of swimmer.swims || []) {
      const value = points.get(Number(swim.usasSwimTimeKey));
      if (Number.isFinite(value)) {
        swim.powerPoints = value;
        assigned++;
      }
    }
  }
  return { total: keys.length, resolved: points.size, assigned };
}

async function loadPowerPointBatch({ batch, datasource, token, points }) {
  const metadata = [
    column("UsasSwimTime", "UsasSwimTimeKey", "numeric", "UsasSwimTimeKey"),
    column("UsasSwimTime", "PowerPoints", "numeric", "Power Points"),
    scope("UsasSwimTime", "UsasSwimTimeKey", "numeric", { members: batch }, "UsasSwimTimeKey")
  ];
  let lastError = null;
  for (let attempt = 1; attempt <= POWER_POINT_BATCH_ATTEMPTS; attempt++) {
    try {
      const result = await jaql(EVENT_RANK_DS, datasource, metadata, token, batch.length, 0);
      for (const row of result.values || []) {
        const key = Number(row[0]?.data ?? row[0]?.text);
        const value = Number(row[1]?.data ?? row[1]?.text);
        if (key && Number.isFinite(value)) points.set(key, value);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < POWER_POINT_BATCH_ATTEMPTS) {
        console.warn(`Power point batch of ${batch.length} failed on attempt ${attempt}; retrying.`);
        await delay(1500 * attempt);
      }
    }
  }
  if (batch.length > POWER_POINT_MIN_BATCH_SIZE) {
    const midpoint = Math.ceil(batch.length / 2);
    console.warn(`Power point batch of ${batch.length} failed; retrying as smaller batches.`);
    await loadPowerPointBatch({ batch: batch.slice(0, midpoint), datasource, token, points });
    await loadPowerPointBatch({ batch: batch.slice(midpoint), datasource, token, points });
    return;
  }
  console.warn(`Power point batch of ${batch.length} failed after retries; leaving those swims with 0 PP. ${lastError?.message || lastError}`);
}

function column(table, columnName, datatype, title = columnName, dim = `[${table}.${columnName}]`) {
  return { jaql: { table, column: columnName, dim, datatype, title } };
}

function scope(table, columnName, datatype, filter, title = columnName, dim = `[${table}.${columnName}]`) {
  return { panel: "scope", jaql: { table, column: columnName, dim, datatype, title, filter } };
}

async function jaql(cubeId, datasource, metadata, token, count = 500, offset = 0) {
  return postJson(`${SISENSE_URL}/api/datasources/${cubeId}/jaql`, {
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
    const [, day, month, year] = match;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return "";
}

function minIsoDate(a, b) {
  return a < b ? a : b;
}

function inferredCurrentAge(...ages) {
  return Math.max(0, ...ages.map(age => Number(age) || 0));
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
