#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const INDEX_HTML = path.join(ROOT, "index.html");
const DATA_JSON = path.join(ROOT, "data", "swimmers.json");
const MIN_SOURCE_SWIMMERS = Number(process.env.MIN_SOURCE_SWIMMERS || 500);
const MIN_PUBLISHED_ROWS = Number(process.env.MIN_PUBLISHED_ROWS || 100);
const REQUIRED_GROUPS = ["11-12|M"];

const source = JSON.parse(await fs.readFile(DATA_JSON, "utf8"));
const html = await fs.readFile(INDEX_HTML, "utf8");
const match = html.match(/const DATA=(.*?);\nconst TARGET=/s);
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
  const expected = {
    personKey: swimmer.personKey ? String(swimmer.personKey) : "",
    name: swimmer.name || "",
    sourcePersonName: swimmer.sourcePersonName || "",
    team: swimmer.team || "",
    gender: normalizeGender(swimmer.gender),
    age: inferredAge,
    ageGroup: ageGroupFor(inferredAge)
  };
  addSourceIdentity(sourceIndex, `person:${expected.personKey}`, expected);
  addSourceIdentity(sourceIndex, `name-team:${identityPart(expected.name)}|${identityPart(expected.team)}`, expected);
  addSourceIdentity(sourceIndex, `name-team:${identityPart(expected.sourcePersonName)}|${identityPart(expected.team)}`, expected);

  if (ageGroupFor(inferredAge) !== ageGroupFor(sourceAge)) {
    errors.push(`${swimmer.name} source age is ${swimmer.age}, but swim age-at-meet implies ${inferredAge} (${ageGroupFor(inferredAge)}).`);
  }
}

for (const [key, rows] of Object.entries(dashboard.groups || {})) {
  const [ageGroup, gender] = key.split("|");
  for (const row of rows) {
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
