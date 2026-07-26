#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_HTML = path.join(ROOT, "index.html");
const DATA_JSON = path.join(ROOT, "data", "swimmers.json");
const MIN_SOURCE_SWIMMERS = Number(process.env.MIN_SOURCE_SWIMMERS || 500);
const MIN_PUBLISHED_ROWS = Number(process.env.MIN_PUBLISHED_ROWS || 100);
const REQUIRED_GROUPS = ["11-12|M"];

const source = JSON.parse(await fs.readFile(DATA_JSON, "utf8"));
const html = await fs.readFile(INDEX_HTML, "utf8");
const match = html.match(/const DATA=(.*?);\nconst [A-Z][A-Z0-9_]*=/s);
if (!match) throw new Error("Could not find embedded dashboard DATA in index.html.");
const dashboard = JSON.parse(match[1]);

const errors = [];
const sourceSwimmers = source.swimmers || [];
if (sourceSwimmers.length < MIN_SOURCE_SWIMMERS) {
  errors.push(`Current data/swimmers.json has only ${sourceSwimmers.length} swimmers; expected at least ${MIN_SOURCE_SWIMMERS}. Refusing to publish likely-empty refresh output.`);
}

const publishedRows = Object.values(dashboard.groups || {}).reduce((sum, rows) => sum + rows.length, 0);
if (publishedRows < MIN_PUBLISHED_ROWS) {
  errors.push(`Published dashboard has only ${publishedRows} swimmer rows; expected at least ${MIN_PUBLISHED_ROWS}. Refusing to publish likely-empty dashboard.`);
}

for (const groupKey of REQUIRED_GROUPS) {
  const rows = dashboard.groups?.[groupKey] || [];
  if (!rows.length) {
    errors.push(`Required dashboard group ${groupKey} has no swimmers.`);
  }
}

const sourceIndex = new Map();
for (const swimmer of sourceSwimmers) {
  const inferredAge = inferredCurrentAge(swimmer);
  const sourceAge = Number(swimmer.age) || 0;
  if (ageGroupFor(inferredAge) !== ageGroupFor(sourceAge)) {
    errors.push(`${swimmer.name} source age is ${swimmer.age}, but swim age-at-meet implies ${inferredAge} (${ageGroupFor(inferredAge)}).`);
  }
}

const canonicalSourceSwimmers = mergeDuplicateSwimmers(sourceSwimmers.map(swimmer => {
  const age = inferredCurrentAge(swimmer);
  return {
    ...swimmer,
    age,
    gender: normalizeGender(swimmer.gender),
    ageGroup: ageGroupFor(age),
    swims: swimmer.swims || []
  };
}));

for (const swimmer of canonicalSourceSwimmers) {
  const inferredAge = inferredCurrentAge(swimmer);
  const expected = {
    personKey: swimmer.personKey ? String(swimmer.personKey) : "",
    name: swimmer.name || "",
    sourcePersonName: swimmer.sourcePersonName || "",
    team: latestTeam(swimmer) || swimmer.team || "",
    gender: normalizeGender(swimmer.gender),
    age: inferredAge,
    ageGroup: ageGroupFor(inferredAge)
  };
  addSourceIdentity(sourceIndex, `person:${expected.personKey}`, expected);
  addSourceIdentity(sourceIndex, `name-team:${identityPart(expected.name)}|${identityPart(expected.team)}`, expected);
  addSourceIdentity(sourceIndex, `name-team:${identityPart(expected.sourcePersonName)}|${identityPart(expected.team)}`, expected);
}

for (const [key, rows] of Object.entries(dashboard.groups || {})) {
  const [ageGroup, gender] = key.split("|");
  const publishedPersonKeys = new Map();
  for (const row of rows) {
    if (row.personKey) {
      const publishedKey = String(row.personKey);
      const duplicate = publishedPersonKeys.get(publishedKey);
      if (duplicate) {
        errors.push(`USA Swimming identity ${publishedKey} is published more than once in ${key}: ${duplicate.name} (${duplicate.team}) and ${row.name} (${row.team}).`);
      } else {
        publishedPersonKeys.set(publishedKey, row);
      }
    }

    const expected = ageGroupFor(Number(row.age) || 0);
    if (expected !== ageGroup) {
      errors.push(`${row.name} age ${row.age} is published in ${key}; expected ${expected}|${gender}.`);
    }

    const currentSource = findSourceForPublishedRow(sourceIndex, row);
    if (!currentSource) {
      errors.push(`${row.name} (${row.team}) is published in ${key}, but no matching swimmer exists in current data/swimmers.json.`);
      continue;
    }
    if (Number(row.age) !== currentSource.age) {
      errors.push(`${row.name} (${row.team}) is published as age ${row.age}, but current source age is ${currentSource.age}.`);
    }
    if (ageGroup !== currentSource.ageGroup) {
      errors.push(`${row.name} (${row.team}) is published in ${key}, but current source age ${currentSource.age} belongs in ${currentSource.ageGroup}|${currentSource.gender}.`);
    }
    if (normalizeGender(row.gender) !== currentSource.gender || gender !== currentSource.gender) {
      errors.push(`${row.name} (${row.team}) is published in gender ${gender}, but current source gender is ${currentSource.gender}.`);
    }
  }
}

if (errors.length) {
  console.error("Age-group validation failed:");
  for (const error of errors.slice(0, 50)) console.error(`- ${error}`);
  if (errors.length > 50) console.error(`- ...and ${errors.length - 50} more`);
  process.exit(1);
}

console.log("Age-group validation passed.");

function inferredCurrentAge(swimmer) {
  const ages = [Number(swimmer.age) || 0];
  for (const swim of swimmer.swims || []) {
    ages.push(Number(swim.ageAtMeet) || 0);
  }
  return Math.max(...ages);
}

function latestTeam(swimmer) {
  return (swimmer.swims || [])
    .filter(swim => swim.team && parseMeetDate(swim.date))
    .sort((a, b) => +parseMeetDate(b.date) - +parseMeetDate(a.date))[0]?.team || "";
}

function mergeDuplicateSwimmers(swimmers) {
  const parent = swimmers.map((_, index) => index);
  const seenTokens = new Map();
  const historyTokenOwners = new Map();
  swimmers.forEach((swimmer, index) => {
    for (const token of identityTokens(swimmer)) {
      const first = seenTokens.get(token);
      if (first === undefined) seenTokens.set(token, index);
      else union(parent, first, index);
    }
    for (const token of swimHistoryTokens(swimmer)) {
      const owners = historyTokenOwners.get(token) || [];
      owners.push(index);
      historyTokenOwners.set(token, owners);
    }
  });

  const pairOverlaps = new Map();
  for (const owners of historyTokenOwners.values()) {
    const uniqueOwners = [...new Set(owners)];
    for (let i = 0; i < uniqueOwners.length; i += 1) {
      for (let j = i + 1; j < uniqueOwners.length; j += 1) {
        const pair = `${uniqueOwners[i]}|${uniqueOwners[j]}`;
        pairOverlaps.set(pair, (pairOverlaps.get(pair) || 0) + 1);
      }
    }
  }
  for (const [pair, overlapCount] of pairOverlaps) {
    if (overlapCount < 2) continue;
    const [a, b] = pair.split("|").map(Number);
    union(parent, a, b);
  }

  const groups = new Map();
  swimmers.forEach((swimmer, index) => {
    const root = find(parent, index);
    const rows = groups.get(root) || [];
    rows.push(swimmer);
    groups.set(root, rows);
  });

  return [...groups.values()].map(mergeSwimmerGroup);
}

function identityTokens(swimmer) {
  const tokens = [];
  if (swimmer.personKey) tokens.push(`id:${swimmer.personKey}`);
  for (const swim of swimmer.swims || []) {
    if (swim.memberId) tokens.push(`id:${swim.memberId}`);
    if (swim.usasSwimTimeKey) tokens.push(`swim:${swim.usasSwimTimeKey}`);
  }
  return [...new Set(tokens.map(String))];
}

function swimHistoryTokens(swimmer) {
  const identity = [
    identityPart(swimmer.sourcePersonName || swimmer.name),
    normalizeGender(swimmer.gender),
    Number(swimmer.age) || 0
  ].join("|");
  const tokens = [];
  for (const swim of swimmer.swims || []) {
    const swimKey = [swim.date, swim.event, swim.course, swim.time, swim.meet]
      .map(value => identityPart(value))
      .join("|");
    if (swimKey.replace(/\|/g, "")) tokens.push(`history:${identity}|${swimKey}`);
  }
  return [...new Set(tokens)];
}

function find(parent, index) {
  while (parent[index] !== index) {
    parent[index] = parent[parent[index]];
    index = parent[index];
  }
  return index;
}

function union(parent, a, b) {
  const rootA = find(parent, a);
  const rootB = find(parent, b);
  if (rootA !== rootB) parent[rootB] = rootA;
}

function mergeSwimmerGroup(rows) {
  const [first] = rows;
  const merged = {
    ...first,
    personKeys: rows.flatMap(row => [row.personKey, ...(row.swims || []).map(swim => swim.memberId)].filter(Boolean)),
    swims: dedupeSwims(rows.flatMap(row => row.swims || []))
  };
  merged.age = Math.max(...rows.map(row => Number(row.age) || 0));
  merged.ageGroup = ageGroupFor(merged.age);
  merged.gender = normalizeGender(merged.gender);
  merged.personKey = stableMergedPersonKey(merged);
  merged.name = rows.reduce((name, row) => longestName(name, row.name), first.name);
  merged.sourcePersonName = first.sourcePersonName || first.name;
  merged.sourceClub = first.sourceClub || first.team || "";
  const latest = latestTeam(merged);
  if (latest) merged.team = latest;
  return merged;
}

function stableMergedPersonKey(swimmer) {
  const keys = [...new Set(swimmer.personKeys || [])].map(String).sort();
  return keys[0] || swimmer.personKey || null;
}

function longestName(a, b) {
  return String(b || "").length > String(a || "").length ? b : a;
}

function dedupeSwims(swims) {
  const byKey = new Map();
  for (const swim of swims || []) {
    const key = [swim.date, swim.event, swim.course, swim.time, swim.meet].map(value => String(value || "")).join("|");
    const existing = byKey.get(key);
    if (!existing || Number(swim.powerPoints) >= Number(existing.powerPoints)) byKey.set(key, swim);
  }
  return [...byKey.values()];
}

function parseMeetDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00`);
  match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return new Date(`${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}T12:00:00`);
  return null;
}

function addSourceIdentity(index, key, swimmer) {
  if (!key || key.endsWith(":") || key.includes(":|") || key.endsWith("|")) return;
  if (index.has(key) && index.get(key) === null) return;
  const existing = index.get(key);
  if (!existing) {
    index.set(key, swimmer);
    return;
  }
  if (existing.personKey !== swimmer.personKey) index.set(key, null);
}

function findSourceForPublishedRow(index, row) {
  const identities = [];
  if (row.personKey) identities.push(`person:${row.personKey}`);
  identities.push(`name-team:${identityPart(row.name)}|${identityPart(row.team)}`);
  if (row.sourcePersonName) identities.push(`name-team:${identityPart(row.sourcePersonName)}|${identityPart(row.team)}`);

  for (const key of identities) {
    const match = index.get(key);
    if (match) return match;
  }
  return null;
}

function identityPart(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeGender(value) {
  const raw = String(value || "").toUpperCase();
  if (raw.startsWith("F")) return "F";
  return "M";
}

function ageGroupFor(age) {
  if (age <= 10) return "10&U";
  if (age <= 12) return "11-12";
  if (age <= 14) return "13-14";
  if (age <= 16) return "15-16";
  return "17-18";
}
