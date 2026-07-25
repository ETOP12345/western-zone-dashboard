#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const SWIMMERS_JSON = path.join(DATA_DIR, "swimmers.json");
const STATUS_JSON = path.join(DATA_DIR, "usa-event-rank-status.json");

const TIMES_API = "https://times-api.usaswimming.org/swims";
const REQUEST_TIMEOUT_MS = 75000;
const REQUEST_ATTEMPTS = 3;
const POST_ATTEMPTS = 5;
const MIN_REFRESH_SWIMMERS = Number(process.env.MIN_REFRESH_SWIMMERS || 500);
const MIN_REFRESH_EVENT_ROWS = Number(process.env.MIN_REFRESH_EVENT_ROWS || 500);
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
  { value: "M", label: "Male", topTimesId: 1 },
  { value: "F", label: "Female", topTimesId: 2 }
];
const EVENT_QUERIES = [
  ["50 Free", "LCM", 55],
  ["100 Free", "LCM", 56],
  ["200 Free", "LCM", 57],
  ["400 Free", "LCM", 58],
  ["50 Back", "LCM", 65],
  ["100 Back", "LCM", 66],
  ["200 Back", "LCM", 67],
  ["50 Breast", "LCM", 68],
  ["100 Breast", "LCM", 69],
  ["200 Breast", "LCM", 70],
  ["50 Fly", "LCM", 71],
  ["100 Fly", "LCM", 72],
  ["200 Fly", "LCM", 73],
  ["200 IM", "LCM", 74],
  ["400 IM", "LCM", 75],
  ["50 Free", "SCY", 1],
  ["100 Free", "SCY", 2],
  ["200 Free", "SCY", 3],
  ["500 Free", "SCY", 4],
  ["50 Back", "SCY", 11],
  ["100 Back", "SCY", 12],
  ["200 Back", "SCY", 13],
  ["50 Breast", "SCY", 14],
  ["100 Breast", "SCY", 15],
  ["200 Breast", "SCY", 16],
  ["50 Fly", "SCY", 17],
  ["100 Fly", "SCY", 18],
  ["200 Fly", "SCY", 19],
  ["100 IM", "SCY", 20],
  ["200 IM", "SCY", 21],
  ["400 IM", "SCY", 22]
];

const startedAt = new Date().toISOString();
await fs.mkdir(DATA_DIR, { recursive: true });
const refreshWarnings = [];

const previousPayload = await readPreviousPayload();
const swimmersByKey = new Map();
for (const swimmer of previousPayload.swimmers || []) {
  swimmersByKey.set(swimmerIdentity(swimmer), {
    ...swimmer,
    swims: [...(swimmer.swims || [])]
  });
}

const rowsByGroup = {};
for (const ageGroup of AGE_GROUPS) {
  for (const gender of GENDERS) {
    const groupKey = `${ageGroup.label}|${gender.value}`;
    rowsByGroup[groupKey] = {};
    for (const [event, course, eventId] of EVENT_QUERIES) {
      let rows = [];
      try {
        rows = await getTopTimesRows({ ageGroup, gender, eventId });
      } catch (error) {
        const warning = `${groupKey} ${course} ${event}: ${error.message}`;
        refreshWarnings.push(warning);
        console.warn(`Warning: ${warning}`);
      }
      rowsByGroup[groupKey][`${course} ${event}`] = rows.length;
      for (const row of rows) {
        if (!row.memberId || row.memberId === "Relay") continue;
        const swimmer = upsertSwimmer(row, gender, ageGroup);
        const swim = topTimesRowToSwim(row, event, course, eventId, gender.topTimesId);
        const existingIndex = swimmer.swims.findIndex(s => s.event === swim.event && s.course === swim.course);
        if (existingIndex === -1 || toSeconds(swim.time) < toSeconds(swimmer.swims[existingIndex].time)) {
          if (existingIndex === -1) swimmer.swims.push(swim);
          else swimmer.swims[existingIndex] = swim;
        }
      }
      console.log(`${groupKey} ${course} ${event}: ${rows.length}`);
      await delay(175);
    }
  }
}

const swimmers = mergeSwimmerRecords([...swimmersByKey.values()]).sort((a, b) =>
  normalizeGender(a.gender).localeCompare(normalizeGender(b.gender)) ||
  Number(a.age) - Number(b.age) ||
  String(a.name).localeCompare(String(b.name))
);

const totalEventRows = sumEventRows(rowsByGroup);
if (swimmers.length < MIN_REFRESH_SWIMMERS || totalEventRows < MIN_REFRESH_EVENT_ROWS) {
  const message = `USA Top Times refresh returned ${swimmers.length} swimmers and ${totalEventRows} event rows; expected at least ${MIN_REFRESH_SWIMMERS} swimmers and ${MIN_REFRESH_EVENT_ROWS} event rows. Refusing to overwrite the last good dashboard data.`;
  await writeStatus("failed-empty-refresh", swimmers.length, totalEventRows, rowsByGroup, message);
  throw new Error(message);
}

const payload = {
  source: "USA Swimming Top Times API via data.usaswimming.org",
  lastUpdated: new Date().toISOString(),
  notes: [
    "Refreshed from the current USA Swimming Top Times API.",
    `Filters: PN LSC, LCM ranking events and SCY tie-break events, ${QUALIFYING_START} through ${QUALIFYING_END}, age group, and gender.`,
    "The former Sisense DataHub route now redirects to the new Top Times app; this refresh merges fresh Top Times rows into the last good swimmer pool.",
    "Power points are read directly from USA Swimming Top Times response rows.",
    "USA Swimming currently returns up to 25 Top Times rows per event; existing swimmer rows are retained so the all-around pool does not collapse when lower event ranks are not returned.",
    ...(refreshWarnings.length ? [`${refreshWarnings.length} event queries failed during this refresh; previous swimmer rows were retained where available for missed events.`] : [])
  ],
  swimmers
};

await fs.writeFile(SWIMMERS_JSON, JSON.stringify(payload, null, 2));
await writeStatus("refreshed", swimmers.length, totalEventRows, rowsByGroup, null, refreshWarnings);
console.log(`USA Top Times refresh: ${swimmers.length} unique swimmers loaded; ${totalEventRows} event rows checked; ${refreshWarnings.length} warnings.`);

async function readPreviousPayload() {
  try {
    return JSON.parse(await fs.readFile(SWIMMERS_JSON, "utf8"));
  } catch {
    return { swimmers: [] };
  }
}

function upsertSwimmer(row, gender, ageGroup) {
  const normalizedName = identityPart(row.fullName);
  const normalizedTeam = identityPart(row.clubName);
  const existing = [...swimmersByKey.values()].find(swimmer =>
    normalizeGender(swimmer.gender) === gender.value &&
    identityPart(swimmer.sourcePersonName || swimmer.name) === normalizedName &&
    identityPart(swimmer.team || swimmer.sourceClub) === normalizedTeam
  );
  const key = existing ? swimmerIdentity(existing) : `person:${row.memberId}|${gender.value}`;
  if (!swimmersByKey.has(key)) {
    swimmersByKey.set(key, {
      name: row.fullName || "",
      team: row.clubName || "",
      age: inferredCurrentAge(row.swimmerAge, ageGroup.to),
      gender: gender.value,
      applied: true,
      personKey: row.memberId,
      sourcePersonName: row.fullName || "",
      sourceClub: row.clubName || "",
      source: "USA Swimming Top Times API",
      swims: []
    });
  }
  const swimmer = swimmersByKey.get(key);
  swimmer.name ||= row.fullName || "";
  swimmer.sourcePersonName ||= row.fullName || "";
  swimmer.team ||= row.clubName || "";
  swimmer.sourceClub ||= row.clubName || "";
  swimmer.gender = gender.value;
  swimmer.age = Math.max(Number(swimmer.age) || 0, Number(row.swimmerAge) || 0);
  return swimmer;
}

async function getTopTimesRows({ ageGroup, gender, eventId }) {
  const body = {
    bestTimesOnly: 1,
    competitionGenderTypeId: gender.topTimesId,
    eventId,
    seasonKey: null,
    startDate: isoToUsDate(QUALIFYING_START),
    endDate: isoToUsDate(QUALIFYING_END),
    minAge: ageGroup.from,
    maxAge: ageGroup.to,
    lscCode: "PN",
    zoneCode: null,
    timeStandardType: null,
    loggedInUserClubs: false,
    teamUsaEligible: false
  };
  const result = await postJson(`${TIMES_API}/TimesSearch/GetTopTimesLeaderBoard`, body);
  return Array.isArray(result) ? result : [];
}

function topTimesRowToSwim(row, event, course, eventId, genderId) {
  return {
    event,
    course,
    time: cleanTime(row.swimTime),
    date: parseApiDate(row.swimDate),
    meet: row.meetName || "",
    powerPoints: Number(row.powerPoints) || 0,
    standard: row.timeStandard || "",
    lsc: row.lscCode || "",
    team: row.clubName || "",
    swimEventKey: eventId,
    eventCompetitionCategoryKey: genderId,
    usasSwimTimeKey: Number(row.swimTimeId) || null,
    memberId: row.memberId || "",
    ageAtMeet: Number(row.swimmerAge) || null
  };
}

async function writeStatus(status, swimmerCount, totalEventRows, groups, error = null, warnings = []) {
  await fs.writeFile(STATUS_JSON, JSON.stringify({
    checkedAt: startedAt,
    finishedAt: new Date().toISOString(),
    status,
    source: "USA Swimming Top Times API via data.usaswimming.org",
    swimmers: swimmerCount,
    rowsPerEvent: 25,
    scyRowsPerEvent: 25,
    totalEventRows,
    powerPoints: { total: totalEventRows, resolved: totalEventRows, assigned: totalEventRows },
    groups,
    ...(warnings.length ? { warnings } : {}),
    ...(error ? { error } : {})
  }, null, 2));
}

async function postJson(url, body) {
  let lastError = null;
  for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt++) {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Device-Id": makeDeviceId(),
        "AppName": "DataHub",
        "Usas-Sub-Id": "Anonymous"
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      if (/No records returned/i.test(text)) return [];
      lastError = new Error(`${response.status} ${url}: ${text}`);
      if (isRetryableStatus(response.status) && attempt < POST_ATTEMPTS) {
        await delay(1000 * attempt);
        continue;
      }
      throw lastError;
    }
    try {
      return JSON.parse(text);
    } catch {
      if (/No records returned/i.test(text)) return [];
      lastError = new Error(`Invalid JSON from ${url}: ${text.slice(0, 250)}`);
      if (attempt < POST_ATTEMPTS) {
        await delay(1000 * attempt);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError;
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

function swimmerIdentity(swimmer) {
  if (swimmer.personKey) return `person:${swimmer.personKey}|${normalizeGender(swimmer.gender)}`;
  return `name:${identityPart(swimmer.sourcePersonName || swimmer.name)}|${identityPart(swimmer.team || swimmer.sourceClub)}|${normalizeGender(swimmer.gender)}`;
}

function mergeSwimmerRecords(swimmers) {
  const merged = new Map();
  for (const swimmer of swimmers) {
    const key = swimmerIdentity(swimmer);
    if (!merged.has(key)) {
      merged.set(key, { ...swimmer, swims: [...(swimmer.swims || [])] });
      continue;
    }
    const existing = merged.get(key);
    existing.name ||= swimmer.name || "";
    existing.sourcePersonName ||= swimmer.sourcePersonName || swimmer.name || "";
    existing.team ||= swimmer.team || "";
    existing.sourceClub ||= swimmer.sourceClub || swimmer.team || "";
    existing.age = Math.max(Number(existing.age) || 0, Number(swimmer.age) || 0);
    existing.applied = Boolean(existing.applied || swimmer.applied);
    for (const swim of swimmer.swims || []) {
      const swimIndex = existing.swims.findIndex(s => s.event === swim.event && s.course === swim.course);
      if (swimIndex === -1 || toSeconds(swim.time) < toSeconds(existing.swims[swimIndex].time)) {
        if (swimIndex === -1) existing.swims.push(swim);
        else existing.swims[swimIndex] = swim;
      }
    }
  }
  return [...merged.values()];
}

function sumEventRows(groups) {
  let total = 0;
  for (const events of Object.values(groups)) {
    for (const count of Object.values(events)) total += Number(count) || 0;
  }
  return total;
}

function makeDeviceId() {
  const base = Buffer.from(`platform - vendor - western-zone-dashboard - ${Date.now()}`).toString("base64");
  return base.slice(0, 15) + base.slice(0, 5) + base.slice(15);
}

function isoToUsDate(value) {
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year}`;
}

function parseApiDate(value) {
  const raw = String(value || "");
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function cleanTime(value) {
  return String(value || "").replace(/[a-z]+$/i, "");
}

function minIsoDate(a, b) {
  return a < b ? a : b;
}

function isRetryableStatus(status) {
  return status === 406 || status === 408 || status === 429 || status >= 500;
}

function inferredCurrentAge(...ages) {
  return Math.max(0, ...ages.map(age => Number(age) || 0));
}

function normalizeGender(value) {
  const raw = String(value || "").toUpperCase();
  if (raw.startsWith("F")) return "F";
  return "M";
}

function identityPart(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function toSeconds(value) {
  if (!value) return Infinity;
  const parts = String(value).replace(/[a-z]+$/i, "").split(":").map(Number);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
