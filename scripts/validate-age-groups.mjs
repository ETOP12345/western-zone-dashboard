#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const INDEX_HTML = path.join(ROOT, "index.html");
const DATA_JSON = path.join(ROOT, "data", "swimmers.json");

const source = JSON.parse(await fs.readFile(DATA_JSON, "utf8"));
const html = await fs.readFile(INDEX_HTML, "utf8");
const match = html.match(/const DATA=(.*?);\nconst TARGET=/s);
if (!match) throw new Error("Could not find embedded dashboard DATA in index.html.");
const dashboard = JSON.parse(match[1]);

const errors = [];
for (const swimmer of source.swimmers || []) {
  const inferredAge = inferredCurrentAge(swimmer);
  const sourceAge = Number(swimmer.age) || 0;
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

function ageGroupFor(age) {
  if (age <= 10) return "10&U";
  if (age <= 12) return "11-12";
  if (age <= 14) return "13-14";
  if (age <= 16) return "15-16";
  return "17-18";
}
