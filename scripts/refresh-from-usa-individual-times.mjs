#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const SWIMMERS_JSON = path.join(DATA_DIR, "swimmers.json");
const SEED_SWIMMERS_JSON = path.join(DATA_DIR, "seed-swimmers.json");
const BOOTSTRAP_SEED_JS = path.join(DATA_DIR, "bootstrap-data.js");
const STATUS_JSON = path.join(DATA_DIR, "usa-individual-times-status.json");

const SECURITY_URL = "https://security-api.usaswimming.org/security";
const COMMON_URL = "https://common-api.usaswimming.org/swims";
const SISENSE_URL = "https://usaswimming.sisense.com";
const PERSON_DASHBOARD = "66034c9773fdb1003f76559e";
const PERSON_WIDGET = "66034c9f73fdb1003f7655a0";
const TIMES_DASHBOARD = "6602179473fdb1003f764fe7";
const TIMES_WIDGET = "660217a973fdb1003f764fe9";
const PERSON_DS = "localhost_aPublicIAAaPersonIAAaSearch";
const TIMES_DS = "localhost_aUSAIAAaSwimmingIAAaTimesIAAaElasticube";
const REQUEST_TIMEOUT_MS = 75000;
const REQUEST_ATTEMPTS = 3;

const EVENT_MAP = new Map([
  ["50 FR", "50 Free"], ["100 FR", "100 Free"], ["200 FR", "200 Free"], ["400 FR", "400 Free"], ["500 FR", "500 Free"],
  ["50 BK", "50 Back"], ["100 BK", "100 Back"], ["200 BK", "200 Back"],
  ["50 BR", "50 Breast"], ["100 BR", "100 Breast"], ["200 BR", "200 Breast"],
  ["50 FL", "50 Fly"], ["100 FL", "100 Fly"], ["200 FL", "200 Fly"],
  ["100 IM", "100 IM"], ["200 IM", "200 IM"], ["400 IM", "400 IM"]
]);

const startedAt = new Date().toISOString();
const seedSwimmers = await loadSeedSwimmers();
const token = await getSisenseToken();
const personWidget = await getWidget(PERSON_DASHBOARD, PERSON_WIDGET, token);
const timesWidget = await getWidget(TIMES_DASHBOARD, TIMES_WIDGET, token);

const swimmers = [];
const unresolved = [];
const matched = [];

for (const seedSwimmer of seedSwimmers) {
  const candidate = await findPerson(seedSwimmer, personWidget, token);
  if (!candidate) {
    unresolved.push({ name: seedSwimmer.name, team: seedSwimmer.team });
    continue;
  }
  const swims = await getTimes(candidate.personKey, timesWidget, token);
  swimmers.push({
    name: candidate.name,
    team: candidate.club || seedSwimmer.team,
    age: Number(candidate.age || seedSwimmer.age || 12),
    gender: seedSwimmer.gender || "M",
    applied: seedSwimmer.applied ?? true,
    personKey: candidate.personKey,
    sourcePersonName: candidate.name,
    sourceClub: candidate.club,
    swims
  });
  matched.push({
    seedName: seedSwimmer.name,
    matchedName: candidate.name,
    team: candidate.club,
    age: candidate.age,
    personKey: candidate.personKey,
    swims: swims.length
  });
  await delay(80);
}

const payload = {
  source: "USA Swimming Individual Times Search via Data Hub/Sisense",
  lastUpdated: new Date().toISOString().slice(0, 10),
  notes: [
    "Refreshed from USA Swimming Individual Times Search only.",
    "Person rows were matched by name, PN LSC, age, and team when available.",
    "Rows are unfiltered here; dashboard ranking applies the PNS qualifying window and LCM event rules."
  ],
  swimmers
};

await fs.writeFile(SWIMMERS_JSON, JSON.stringify(payload, null, 2));
await fs.writeFile(STATUS_JSON, JSON.stringify({
  checkedAt: startedAt,
  finishedAt: new Date().toISOString(),
  status: unresolved.length ? "partial" : "refreshed",
  source: payload.source,
  seedSwimmers: seedSwimmers.length,
  matchedSwimmers: matched.length,
  unresolvedSwimmers: unresolved.length,
  matched,
  unresolved
}, null, 2));

console.log(`USA Individual Times refresh: ${matched.length}/${seedSwimmers.length} swimmers matched; ${unresolved.length} unresolved.`);

async function loadSeedSwimmers() {
  try {
    const seed = JSON.parse(await fs.readFile(SEED_SWIMMERS_JSON, "utf8"));
    if (Array.isArray(seed.swimmers) && seed.swimmers.length) return seed.swimmers;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const bootstrap = await loadBootstrapSeed();
  if (bootstrap.length) {
    await fs.writeFile(SEED_SWIMMERS_JSON, JSON.stringify({
      source: "Stable seed list rebuilt from bootstrap-data.js",
      createdAt: new Date().toISOString(),
      notes: [
        "Used only to identify the Team Pacific Northwest candidate pool to query in USA Swimming Individual Times Search.",
        "Daily refresh output is written separately to swimmers.json."
      ],
      swimmers: bootstrap
    }, null, 2));
    return bootstrap;
  }

  const current = JSON.parse(await fs.readFile(SWIMMERS_JSON, "utf8"));
  return (current.swimmers || []).map(seedIdentity);
}

async function loadBootstrapSeed() {
  try {
    const text = await fs.readFile(BOOTSTRAP_SEED_JS, "utf8");
    const jsonText = text
      .replace(/^\s*window\.WESTERN_ZONE_BOOTSTRAP_DATA\s*=\s*/, "")
      .replace(/;\s*$/, "");
    const parsed = JSON.parse(jsonText);
    return (parsed.swimmers || []).map(seedIdentity);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function seedIdentity(swimmer) {
  return {
    name: swimmer.name,
    team: swimmer.team || "",
    age: Number(swimmer.age || 12),
    gender: swimmer.gender || "M",
    applied: swimmer.applied ?? true
  };
}

async function getSisenseToken() {
  const security = await postJson(`${SECURITY_URL}/Auth/GetSecurityInfoForSubId`, {
    subId: "Anonymous",
    sessionId: "",
    toxonomies: [803],
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
    requestUrl: "/datahub/usas/individualsearch"
  });
  if (!auth.accessToken) throw new Error("USA Swimming did not return a Sisense access token.");
  return auth.accessToken;
}

async function getWidget(dashboardOid, widgetOid, token) {
  return getJson(`${SISENSE_URL}/api/v1/dashboards/${dashboardOid}/widgets/${widgetOid}`, token);
}

async function findPerson(seedSwimmer, widget, token) {
  const parts = seedSwimmer.name.trim().split(/\s+/);
  const first = parts[0];
  const last = parts[parts.length - 1];
  const metadata = widget.metadata.panels.find(p => p.name === "columns").items.map(item => ({ jaql: item.jaql }));
  metadata.push(personFilter("FirstAndPreferredName", first));
  metadata.push(personFilter("LastName", last));
  const result = await jaql(PERSON_DS, widget.datasource, metadata, token, 500, 0);
  const candidates = (result.values || []).map(row => ({
    name: row[0]?.text || "",
    club: row[1]?.text || "",
    lsc: row[2]?.text || "",
    age: Number(row[3]?.data ?? row[3]?.text),
    personKey: Number(row[4]?.data ?? row[4]?.text)
  }));
  return bestCandidate(seedSwimmer, candidates);
}

function personFilter(column, value) {
  return {
    panel: "scope",
    jaql: {
      table: "Persons",
      column,
      dim: `[Persons.${column}]`,
      datatype: "text",
      merged: true,
      title: column,
      filter: { contains: value }
    }
  };
}

function bestCandidate(seedSwimmer, candidates) {
  const seedName = normalize(seedSwimmer.name);
  const seedTeam = normalize(seedSwimmer.team);
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    let score = 0;
    if (c.lsc === "PN") score += 50;
    if (c.age >= 11 && c.age <= 12) score += 30;
    if (normalize(c.name) === seedName) score += 25;
    if (normalize(c.name).includes(seedName) || seedName.includes(normalize(c.name))) score += 8;
    if (teamLooksSame(seedTeam, normalize(c.club))) score += 15;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return bestScore >= 70 ? best : null;
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function teamLooksSame(a, b) {
  if (!a || !b) return false;
  const aliases = [
    ["pdst", "pacific dragons swim team"],
    ["bc", "bellevue club swim team"],
    ["bisc", "bainbridge island swim club"],
    ["smac", "seattle metropolitan aquatic c"],
    ["wpro", "wave aquatics"]
  ];
  for (const [shortName, longName] of aliases) {
    if ((a.includes(shortName) || a.includes(longName)) && (b.includes(shortName) || b.includes(longName))) return true;
  }
  return a.includes(b) || b.includes(a) || commonWords(a, b) >= 2;
}

function commonWords(a, b) {
  const left = new Set(a.split(" ").filter(w => w.length > 2));
  return b.split(" ").filter(w => left.has(w)).length;
}

async function getTimes(personKey, widget, token) {
  const metadata = widget.metadata.panels.find(p => p.name === "columns").items.map(item => ({ jaql: item.jaql }));
  metadata.push({
    panel: "scope",
    jaql: {
      table: "UsasSwimTime",
      column: "PersonKey",
      dim: "[UsasSwimTime.PersonKey]",
      datatype: "numeric",
      title: "PersonKey",
      filter: { equals: personKey }
    }
  });
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const result = await jaql(TIMES_DS, widget.datasource, metadata, token, 500, offset);
    const batch = result.values || [];
    rows.push(...batch);
    if (batch.length < 500) break;
  }
  return rows.map(timesRowToSwim).filter(Boolean);
}

function timesRowToSwim(row) {
  const parsed = parseEvent(row[0]?.text || "");
  if (!parsed) return null;
  return {
    event: parsed.event,
    course: parsed.course,
    time: cleanTime(row[1]?.text),
    date: parseUsaDate(row[8]?.text),
    meet: row[5]?.text || "",
    powerPoints: Number(row[3]?.data ?? row[3]?.text) || 0,
    standard: row[4]?.text || "",
    lsc: row[6]?.text || "",
    team: row[7]?.text || "",
    swimEventKey: Number(row[10]?.data ?? row[10]?.text) || null,
    meetKey: Number(row[11]?.data ?? row[11]?.text) || null,
    usasSwimTimeKey: Number(row[13]?.data ?? row[13]?.text) || null
  };
}

function parseEvent(value) {
  const match = String(value).trim().match(/^(.+)\s+(SCY|SCM|LCM)$/);
  if (!match) return null;
  return { event: EVENT_MAP.get(match[1]) || match[1], course: match[2] };
}

function cleanTime(value) {
  return String(value || "").replace(/[a-z]+$/i, "");
}

function parseUsaDate(value) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return "";
  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

async function jaql(datasourceId, datasource, metadata, token, count = 500, offset = 0) {
  return postJson(`${SISENSE_URL}/api/datasources/${datasourceId}/jaql`, {
    datasource,
    metadata,
    count,
    offset
  }, token);
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
      lastError = error?.name === "AbortError"
        ? new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${url}`)
        : error;
      if (attempt === REQUEST_ATTEMPTS) throw lastError;
      await delay(1000 * attempt);
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
