#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = path.join(ROOT, "data", "swimmers.json");
const OUTPUT = process.env.PUBLIC_DASHBOARD_OUTPUT || path.join(ROOT, "index.html");
const DEFAULT_AGE_GROUP = "11-12";
const DEFAULT_GENDER = "M";
const PUBLIC_LIMIT = 50;
const QUALIFYING_START = new Date("2025-07-01T00:00:00");
const ZONE_QUALIFYING_END = new Date("2026-07-25T23:59:59");
const TODAY_END = new Date(`${new Date().toISOString().slice(0, 10)}T23:59:59`);
const QUALIFYING_END = ZONE_QUALIFYING_END < TODAY_END ? ZONE_QUALIFYING_END : TODAY_END;
const EVENT_ORDER = [
  "50 Free", "100 Free", "200 Free", "50 Back", "100 Back", "200 Back",
  "50 Breast", "100 Breast", "200 Breast", "50 Fly", "100 Fly", "200 Fly",
  "200 IM", "400 Free", "400 IM"
];
const AGE_GROUPS = ["10&U", "11-12", "13-14", "15-16", "17-18"];
const GENDERS = [
  ["M", "Male"],
  ["F", "Female"]
];
const AAA_CUTS = {
  LCM: { "50 Free": "28.69", "100 Free": "1:02.39", "200 Free": "2:14.69", "400 Free": "4:43.89", "50 Back": "33.39", "100 Back": "1:11.79", "200 Back": "2:36.19", "50 Breast": "38.49", "100 Breast": "1:23.79", "200 Breast": "3:02.89", "50 Fly": "31.99", "100 Fly": "1:11.99", "200 Fly": "2:44.09", "200 IM": "2:35.89", "400 IM": "5:31.99" },
  SCY: { "50 Free": "25.79", "100 Free": "56.19", "200 Free": "2:02.59", "500 Free": "5:29.99", "50 Back": "29.69", "100 Back": "1:02.79", "200 Back": "2:15.89", "50 Breast": "33.29", "100 Breast": "1:11.39", "200 Breast": "2:34.39", "50 Fly": "28.19", "100 Fly": "1:02.49", "200 Fly": "2:18.69", "100 IM": "1:03.99", "200 IM": "2:18.79", "400 IM": "4:56.29" }
};

const source = JSON.parse(await fs.readFile(INPUT, "utf8"));
const previousDashboard = await readPreviousDashboard(OUTPUT);
const swimmers = mergeDuplicateSwimmers((source.swimmers || []).map(normalizeSwimmer));
const groups = {};
for (const ageGroup of AGE_GROUPS) {
  for (const [gender] of GENDERS) {
    const key = groupKey(ageGroup, gender);
    const groupSwimmers = swimmers.filter(s => s.ageGroup === ageGroup && s.gender === gender);
    groups[key] = calculateRankings(groupSwimmers).map(toCompactSwimmer);
  }
}
applyRankDeltas(groups, previousDashboard?.groups || {});
const rankChanges = summarizeRankChanges(groups);

const compact = {
  source: source.source,
  lastUpdated: source.lastUpdated,
  lastLoadedAt: String(source.lastUpdated || "").includes("T") ? source.lastUpdated : new Date().toISOString(),
  generatedAt: new Date().toISOString(),
  rankChanges,
  defaultAgeGroup: DEFAULT_AGE_GROUP,
  defaultGender: DEFAULT_GENDER,
  ageGroups: AGE_GROUPS,
  genders: GENDERS.map(([value, label]) => ({ value, label })),
  eventOrder: EVENT_ORDER,
  groups
};
validateAgeGroups(compact.groups);

await fs.writeFile(OUTPUT, renderHtml(compact));
console.log(`Wrote ${OUTPUT}`);

async function readPreviousDashboard(outputPath) {
  try {
    const html = await fs.readFile(outputPath, "utf8");
    const match = html.match(/const DATA=(.*?);\nconst [A-Z][A-Z0-9_]*=/s);
    return match ? JSON.parse(match[1]) : null;
  } catch {
    return null;
  }
}

function applyRankDeltas(groups, previousGroups) {
  for (const [key, rows] of Object.entries(groups)) {
    const previous = new Map((previousGroups[key] || []).map(row => [rankIdentity(row), row.rank]));
    for (const row of rows) {
      const previousRank = previous.get(rankIdentity(row)) || null;
      row.previousRank = previousRank;
      row.rankDelta = previousRank ? previousRank - row.rank : null;
    }
  }
}

function summarizeRankChanges(groups) {
  const summary = { changed: 0, up: 0, down: 0, new: 0, same: 0, checked: 0 };
  for (const rows of Object.values(groups)) {
    for (const row of rows.slice(0, PUBLIC_LIMIT)) {
      summary.checked++;
      if (!row.previousRank) {
        summary.new++;
      } else if (row.rankDelta > 0) {
        summary.changed++;
        summary.up++;
      } else if (row.rankDelta < 0) {
        summary.changed++;
        summary.down++;
      } else {
        summary.same++;
      }
    }
  }
  return summary;
}

function rankIdentity(row) {
  if (row.personKey) return `${row.personKey}|${row.ageGroup}|${row.gender}`;
  return `${row.name}|${row.team}|${row.ageGroup}|${row.gender}`;
}

function normalizeSwimmer(swimmer) {
  const age = inferredCurrentAge(swimmer);
  return {
    ...swimmer,
    age,
    gender: normalizeGender(swimmer.gender),
    ageGroup: ageGroupFor(age),
    swims: swimmer.swims || []
  };
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
  const latest = latestTeamSwim(merged.swims || []);
  if (latest?.team) merged.team = latest.team;
  return merged;
}

function identityPart(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
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
    const key = [swim.date, swim.event, swim.course, swim.time, swim.meet].map(v => String(v || "")).join("|");
    const existing = byKey.get(key);
    if (!existing || teamDateWeight(swim) >= teamDateWeight(existing)) byKey.set(key, swim);
  }
  return [...byKey.values()];
}

function latestTeamSwim(swims) {
  return (swims || [])
    .filter(swim => swim.team && parseMeetDate(swim.date))
    .sort((a, b) => teamDateWeight(b) - teamDateWeight(a))[0] || null;
}

function teamDateWeight(swim) {
  const date = parseMeetDate(swim.date);
  return date ? +date : 0;
}

function inferredCurrentAge(swimmer) {
  const ages = [Number(swimmer.age) || 0];
  for (const swim of swimmer.swims || []) {
    ages.push(Number(swim.ageAtMeet) || 0);
  }
  return Math.max(...ages);
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

function groupKey(ageGroup, gender) {
  return `${ageGroup}|${gender}`;
}

function validateAgeGroups(groups) {
  const errors = [];
  for (const [key, rows] of Object.entries(groups)) {
    const [ageGroup, gender] = key.split("|");
    for (const row of rows) {
      const expected = ageGroupFor(Number(row.age) || 0);
      if (expected !== ageGroup) {
        errors.push(`${row.name} age ${row.age} is in ${key}; expected ${expected}|${gender}`);
      }
    }
  }
  if (errors.length) {
    throw new Error(`Age-group validation failed before publish:\n${errors.slice(0, 25).join("\n")}`);
  }
}

function toSeconds(value) {
  if (!value) return Infinity;
  const parts = String(value).replace(/[a-z]+$/i, "").split(":").map(Number);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
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

function inWindow(swim) {
  const date = parseMeetDate(swim.date);
  return date && date >= QUALIFYING_START && date <= QUALIFYING_END;
}

function bestSwim(swimmer, event) {
  return (swimmer.swims || [])
    .filter(s => s.event === event && s.course === "LCM" && inWindow(s))
    .sort((a, b) => toSeconds(a.time) - toSeconds(b.time))[0] || null;
}

function qualifies(swim, cuts) {
  if ((swim.course === "LCM" || swim.course === "SCY") && isAaaOrBetter(swim.standard)) return true;
  return cuts[swim.event] && toSeconds(swim.time) <= toSeconds(cuts[swim.event]);
}

function isAaaOrBetter(standard) {
  return ["AAA", "AAAA"].includes(String(standard || "").trim().toUpperCase());
}

function countCuts(swimmer) {
  const eligible = (swimmer.swims || []).filter(inWindow);
  return {
    lcmAAA: eligible.filter(s => s.course === "LCM" && qualifies(s, AAA_CUTS.LCM)).length,
    scyAAA: eligible.filter(s => s.course === "SCY" && qualifies(s, AAA_CUTS.SCY)).length
  };
}

function swimmerKey(swimmer) {
  return swimmer.personKey || `${swimmer.name}|${swimmer.team}|${swimmer.age}|${swimmer.gender}`;
}

function calculateRankings(swimmers) {
  const eventRanks = new Map();
  for (const event of EVENT_ORDER) {
    const rows = swimmers
      .map(swimmer => ({ swimmer, swim: bestSwim(swimmer, event) }))
      .filter(row => row.swim)
      .sort((a, b) => toSeconds(a.swim.time) - toSeconds(b.swim.time));
    rows.forEach((row, index) => eventRanks.set(`${swimmerKey(row.swimmer)}|${event}`, index + 1));
  }

  const rankings = swimmers.map(swimmer => {
    const eventDetails = EVENT_ORDER.map(event => {
      const swim = bestSwim(swimmer, event);
      return { event, rank: swim ? eventRanks.get(`${swimmerKey(swimmer)}|${event}`) || null : null, swim };
    });
    const rankedEvents = eventDetails.filter(e => e.rank && e.swim);
    const topSix = rankedEvents.slice().sort((a, b) => a.rank - b.rank).slice(0, 6);
    const cuts = countCuts(swimmer);
    const rankingPower = topSix.reduce((sum, e) => sum + (Number(e.swim.powerPoints) || 0), 0);
    const score = topSix.length === 6 ? topSix.reduce((sum, e) => sum + e.rank, 0) : 999 + topSix.reduce((sum, e) => sum + e.rank, 0);
    return { ...swimmer, eventDetails, topSix, cuts, rankingPower, score };
  });
  rankings.sort((a, b) =>
    a.score - b.score ||
    b.cuts.lcmAAA - a.cuts.lcmAAA ||
    b.cuts.scyAAA - a.cuts.scyAAA ||
    b.rankingPower - a.rankingPower
  );
  rankings.forEach((r, index) => r.rank = index + 1);
  return rankings;
}

function toCompactSwim(swim) {
  if (!swim) return null;
  return {
    event: swim.event,
    course: swim.course,
    time: swim.time,
    date: swim.date,
    meet: swim.meet,
    pp: Number(swim.powerPoints) || 0,
    std: swim.standard || ""
  };
}

function tieType(swim) {
  if (swim.course === "LCM" && isAaaOrBetter(swim.standard)) return "LCM AAA";
  if (swim.course === "SCY" && isAaaOrBetter(swim.standard)) return "SCY AAA";
  return "";
}

function toCompactSwimmer(r) {
  return {
    personKey: r.personKey || null,
    name: r.name,
    sourcePersonName: r.sourcePersonName || r.name,
    team: r.team,
    age: r.age,
    gender: r.gender,
    ageGroup: r.ageGroup,
    rank: r.rank,
    score: r.score,
    pp: r.rankingPower,
    cuts: r.cuts,
    status: r.rank <= 12 ? "Selected" : r.rank <= 14 ? `Alternate ${r.rank - 12}` : "Outside",
    topSix: r.topSix.map(e => ({ event: e.event, rank: e.rank, swim: toCompactSwim(e.swim) })),
    events: r.eventDetails.map(e => ({ event: e.event, rank: e.rank, swim: toCompactSwim(e.swim) })),
    ties: (r.swims || [])
      .filter(inWindow)
      .map(swim => ({ type: tieType(swim), swim: toCompactSwim(swim) }))
      .filter(row => row.type)
      .sort((a, b) => a.type.localeCompare(b.type) || a.swim.event.localeCompare(b.swim.event) || toSeconds(a.swim.time) - toSeconds(b.swim.time))
  };
}

function renderHtml(data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team Pacific Northwest Zones Ranking</title>
<style>
:root{--ink:#17202a;--muted:#64748b;--line:#d7dee8;--paper:#fff;--band:#f4f7fb;--green:#157347;--gold:#996515;--red:#b42318;--blue:#1d4ed8}*{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:#eef3f8}button,select{font:inherit}header{padding:22px 28px;color:#fff;background:#123447}h1,h2,p{margin-top:0}h1{margin-bottom:0;font-size:28px}.eyebrow{margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#bde8ef}main{max-width:1480px;margin:0 auto;padding:20px}.disclaimer{margin-bottom:16px;border:1px solid #f2c94c;background:#fff8db;padding:12px 14px;line-height:1.45}.disclaimer strong{color:#7a4b00}.disclaimer small{display:block;margin-top:4px;color:var(--muted)}.status-band{display:grid;grid-template-columns:repeat(4,1fr);margin-bottom:16px;border:1px solid var(--line);background:var(--paper)}.status-band>div{padding:16px;border-right:1px solid var(--line)}.status-band>div:last-child{border-right:0}.label,small,.muted{color:var(--muted)}.label{display:block;margin-bottom:4px;font-size:12px;font-weight:700;text-transform:uppercase}.status-band strong{display:block;font-size:24px}.controls{display:grid;grid-template-columns:180px 160px minmax(260px,1fr);gap:12px;margin-bottom:12px;padding:14px;border:1px solid var(--line);background:var(--band)}.field label{display:block;margin-bottom:5px;font-size:12px;font-weight:700;color:var(--muted)}.field select{width:100%;height:40px;border:1px solid var(--line);border-radius:6px;padding:0 10px;background:white}.tabs{display:flex;gap:8px;margin-bottom:16px}.tab-button{border:1px solid var(--line);border-radius:6px;padding:9px 14px;background:var(--paper);color:var(--ink);font-weight:700;cursor:pointer}.tab-button.active{border-color:#123447;background:#123447;color:white}.view-panel{display:none}.view-panel.active{display:block}.team-distribution{margin-bottom:16px;border:1px solid var(--line);background:var(--paper)}.team-dist-body{padding:4px 16px}.team-chart-body{position:relative;padding:16px}.chart-wrap{overflow-x:auto}.team-line-chart{display:block;width:100%;min-width:760px;height:auto}.chart-grid{stroke:#dbe3ed;stroke-width:1}.chart-axis{stroke:#8da0b6;stroke-width:1.4}.chart-label{fill:var(--muted);font-size:12px}.chart-team-line{fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;transition:opacity .12s ease,stroke-width .12s ease}.chart-team-line.minor{stroke-width:1.2;opacity:.35}.chart-series.active .chart-team-line{stroke-width:4;opacity:1}.team-chart-body.chart-focused .chart-series:not(.active) .chart-team-line{stroke:#94a3b8;opacity:.14}.team-chart-body.chart-focused .chart-series:not(.active) .chart-dot{opacity:.16}.team-chart-body.chart-focused .chart-series.active .chart-dot{opacity:1}.chart-hit-line{fill:none;stroke:transparent;stroke-width:14;stroke-linecap:round;stroke-linejoin:round;cursor:pointer}.chart-dot{stroke:white;stroke-width:1.5;transition:opacity .12s ease}.chart-dot.minor-dot{opacity:0}.chart-hover-target{cursor:pointer}.chart-tooltip{display:none;position:fixed;z-index:30;max-width:280px;border:1px solid var(--line);border-radius:6px;padding:9px 10px;background:#0f172a;color:white;box-shadow:0 8px 24px rgba(15,23,42,.18);font-size:12px;line-height:1.35;pointer-events:none}.chart-tooltip strong{display:block;margin-bottom:3px;color:white}.chart-tooltip span{color:#cbd5e1}.chart-legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.legend-item{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)}.legend-swatch{width:18px;height:3px;border-radius:999px}.team-row{display:grid;width:100%;grid-template-columns:minmax(220px,1fr) minmax(160px,260px) minmax(220px,1.3fr);align-items:center;gap:14px;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:12px 0;background:transparent;color:var(--ink);text-align:left;cursor:pointer}.team-row:last-child{border-bottom:0}.team-row:hover{background:#f8fafc}.team-name strong{display:block}.team-count{font-weight:700;color:var(--blue)}.team-bar-track{height:10px;margin-top:4px;border-radius:999px;overflow:hidden;background:#e2e8f0}.team-bar-fill{height:100%;border-radius:999px;background:var(--blue)}.rank-strip-wrap small{display:block;margin-bottom:4px}.rank-strip{position:relative;height:18px;border-radius:999px;background:linear-gradient(90deg,#dbeafe,#dcfce7)}.rank-dot{position:absolute;top:4px;width:10px;height:10px;border-radius:999px;background:var(--green);box-shadow:0 0 0 2px #fff;transform:translateX(-50%)}.content-grid{display:grid;grid-template-columns:minmax(0,1fr) 430px;gap:16px;margin-bottom:16px}.rank-panel,.detail-panel,.rules-panel{border:1px solid var(--line);background:var(--paper)}.panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}.panel-head h2{margin:0}.panel-actions{display:flex;align-items:center;gap:8px}.panel-head button{border:1px solid var(--line);border-radius:6px;padding:8px 12px;background:var(--band);color:var(--ink);font-weight:700;cursor:pointer}.mobile-back{display:none}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:860px}th,td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);text-transform:uppercase;background:#f8fafc}tbody tr{cursor:pointer}tbody tr:hover{background:#f5fbfc}tbody tr.selected-row{background:#e8f6f7}.rank-change{display:block;margin-top:2px;font-size:12px;font-weight:700}.rank-up{color:var(--green)}.rank-down{color:var(--red)}.rank-new{color:var(--blue)}.rank-same{color:var(--muted)}.pill{display:inline-flex;align-items:center;min-height:24px;border:0;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:700;white-space:nowrap;background:#e2e8f0;color:#334155}.pill.selected{background:#d1fae5;color:var(--green)}.pill.alternate{background:#fef3c7;color:var(--gold)}.pill.outside{background:#fee2e2;color:var(--red)}.event-list{display:flex;flex-wrap:wrap;gap:5px}.text-link{display:inline;border:0;border-radius:0;padding:0;background:transparent;color:inherit;font-weight:inherit;text-align:left;cursor:pointer}.event-link:hover,.text-link:hover{text-decoration:underline}.detail-body{padding:16px}.metric-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px}.metric{padding:10px;border:1px solid var(--line);background:#f8fafc}.metric strong{display:block;font-size:20px}.swim-card{padding:10px 0;border-top:1px solid var(--line)}.swim-card:first-of-type{border-top:0}.swim-card h3{margin:0 0 5px;font-size:15px}.swim-meta{color:var(--muted);font-size:13px;line-height:1.45}.mini-table{border-top:1px solid var(--line)}.mini-row{display:flex;width:100%;justify-content:space-between;gap:12px;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:10px 0;background:transparent;color:var(--ink);text-align:left;cursor:pointer}.mini-row:hover{background:#f8fafc}.mini-row span:last-child{text-align:right;white-space:nowrap}.mini-row small{display:block;margin-top:2px}.mini-note{margin:-7px 0 7px;padding-bottom:8px;border-bottom:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.4}.rules-panel{padding:16px 18px}.rules-panel li{margin-bottom:8px;line-height:1.45}.empty{padding:24px;color:var(--muted)}@media(max-width:980px){.status-band,.controls,.content-grid,.team-row{grid-template-columns:1fr}.status-band>div{border-right:0;border-bottom:1px solid var(--line)}.status-band>div:last-child{border-bottom:0}}@media(max-width:700px){header{padding:16px}h1{font-size:22px}main{padding:10px}.status-band strong{font-size:20px}.controls{padding:10px;gap:10px}.tabs{overflow-x:auto}.team-chart-body{padding:12px}.team-dist-body{padding:2px 12px}.team-row{gap:8px;padding:12px 0}.table-wrap{overflow-x:auto}.detail-panel{display:none}.mobile-detail-open .rank-panel,.mobile-detail-open .rules-panel,.mobile-detail-open .team-distribution,.mobile-detail-open .tabs{display:none}.mobile-detail-open .detail-panel{display:block}.mobile-detail-open .controls{display:none}.mobile-back{display:inline-flex}.panel-head{position:sticky;top:0;z-index:2;background:var(--paper)}.panel-head h2{font-size:18px}.metric-grid{grid-template-columns:1fr}.mini-row{align-items:flex-start}.detail-body{padding:14px}}
.legend-hover{cursor:pointer}.legend-item.active{color:var(--ink);font-weight:700}
.strong-controls{display:flex;align-items:center;gap:8px}.strong-controls label{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase}.strong-controls select{height:34px;max-width:260px;border:1px solid var(--line);border-radius:6px;padding:0 8px;background:white}.stack-bar{transition:opacity .12s ease}.stack-bar:hover{opacity:.86}.strong-legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}.strong-legend span{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)}.strong-legend i{display:inline-block;width:12px;height:12px;border-radius:2px}
</style>
</head>
<body>
<header><p class="eyebrow">Team Pacific Northwest</p><h1>Western Zone Ranking Dashboard</h1></header>
<main>
<section class="disclaimer"><strong>Disclaimer:</strong> This dashboard is an unofficial estimate based only on our interpretation of the published selection rubric and loaded USA Swimming data. Scores, rankings, and eligibility factors may contain mistakes, missing data, or wrong interpretations. These are not official Team Pacific Northwest or USA Swimming results, and we do not take responsibility for decisions made from this dashboard.<br><small id="disclaimerMeta">Loading data status...</small></section>
<section class="controls"><div class="field"><label for="ageGroupSelect">Age Group</label><select id="ageGroupSelect"></select></div><div class="field"><label for="genderSelect">Gender</label><select id="genderSelect"></select></div><div class="field"><label for="swimmerSelect">Swimmer</label><select id="swimmerSelect"></select></div></section>
<nav class="tabs" aria-label="Dashboard views"><button id="swimmersTab" class="tab-button active" type="button" data-tab="swimmers">Swimmers</button><button id="teamsTab" class="tab-button" type="button" data-tab="teams">Teams</button></nav>
<section id="swimmersView" class="view-panel active"><section class="content-grid"><div class="rank-panel"><div class="panel-head"><h2>Top 50 Ranking Pool</h2><span id="applicantCount">0 swimmers</span></div><div class="table-wrap"><table><thead><tr><th>Rank</th><th>Swimmer</th><th>Team</th><th>Score</th><th>6 Scoring Events</th><th>AAA / Tie</th><th>Status</th></tr></thead><tbody id="rankingBody"></tbody></table></div></div><aside class="detail-panel"><div class="panel-head"><h2 id="detailTitle">Details</h2><div class="panel-actions"><button id="backToRankings" class="mobile-back" type="button">Rankings</button><button id="resetDetail" type="button" title="Clear detail pane">Clear</button></div></div><div id="detailBody" class="detail-body"></div></aside></section></section>
<section id="teamsView" class="view-panel"><section class="team-distribution"><div class="panel-head"><h2>Team Distribution Trend</h2><span id="teamTrendCount">0 teams</span></div><div id="teamTrendChart" class="team-chart-body"></div></section><section class="team-distribution"><div class="panel-head"><h2>Strong Swimmer Types</h2><div class="strong-controls"><label for="strongTypeTeamSelect">Team</label><select id="strongTypeTeamSelect"></select></div></div><div id="strongTypeChart" class="team-chart-body"></div></section><section class="team-distribution"><div class="panel-head"><h2>Selected Group Distribution</h2><span id="teamDistributionCount">0 teams</span></div><div id="teamDistributionBody" class="team-dist-body"></div></section></section>
<section class="rules-panel"><h2>Selection Factors Implemented</h2><ul><li>Default view is 11-12 Male, top 50 swimmers.</li><li>Ranking events are LCM 50/100/200 free, back, breast, fly; 200 IM; 400 free; and 400 IM.</li><li>Eligible times are July 1, 2025 through July 25, 2026.</li><li>Primary score is the sum of each applicant's six best relative event ranks. Lowest score ranks highest.</li><li>Tie-break priority: more LCM AAA times, then more SCY AAA times, then higher power-point total for the six ranking events.</li></ul></section>
</main>
<script>
const DATA=${json};
const LIMIT=50;
const TEAM_TREND_MIN_SWIMMERS=5;
let state={ageGroup:DATA.defaultAgeGroup,gender:DATA.defaultGender,selected:"",detail:{type:"none"},mobileDetail:false,tab:"swimmers",strongTeam:""};
const $=s=>document.querySelector(s);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));
function groupKey(){return state.ageGroup+"|"+state.gender}
function currentAll(){return DATA.groups[groupKey()]||[]}
function currentRows(){return currentAll().slice(0,LIMIT)}
function fmtDate(v){if(!v)return"date unknown";const d=new Date(v+"T12:00:00");return Number.isNaN(+d)?v:d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
function fmtDateTime(v){if(!v)return"--";const d=new Date(v);return Number.isNaN(+d)?v:d.toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",timeZoneName:"short"})}
function rankChangeText(r){if(r.previousRank==null)return"new";if(r.rankDelta>0)return"up "+r.rankDelta;if(r.rankDelta<0)return"down "+Math.abs(r.rankDelta);return"same"}
function rankChangeClass(r){if(r.previousRank==null)return"rank-new";if(r.rankDelta>0)return"rank-up";if(r.rankDelta<0)return"rank-down";return"rank-same"}
function rankSummaryText(){let c=DATA.rankChanges||{};if(!c.checked)return"rank baseline starts now";if((c.changed||0)===0&&(c.new||0)===0)return"no rank changes";return(c.changed||0)+" changed, "+(c.new||0)+" new"}
function statusClass(s){return s.startsWith("Selected")?"selected":s.startsWith("Alternate")?"alternate":"outside"}
function genderLabel(){return (DATA.genders.find(g=>g.value===state.gender)||{}).label||state.gender}
function setupControls(){DATA.ageGroups.forEach(g=>$("#ageGroupSelect").insertAdjacentHTML("beforeend",'<option value="'+esc(g)+'">'+esc(g)+'</option>'));DATA.genders.forEach(g=>$("#genderSelect").insertAdjacentHTML("beforeend",'<option value="'+esc(g.value)+'">'+esc(g.label)+'</option>'));$("#ageGroupSelect").value=state.ageGroup;$("#genderSelect").value=state.gender}
function refreshSwimmerSelect(){let rows=currentRows();let opts=['<option value="">All 50 swimmers</option>'].concat(rows.map(r=>'<option value="'+esc(r.name)+'">'+esc("#"+r.rank+" "+r.name)+'</option>'));$("#swimmerSelect").innerHTML=opts.join("");$("#swimmerSelect").value=state.selected||""}
function filteredRows(){let rows=currentRows();return state.selected?rows.filter(r=>r.name===state.selected):rows}
function rowsFor(ageGroup){return (DATA.groups[ageGroup+"|"+state.gender]||[]).slice(0,LIMIT)}
function teamTrendRows(){let byTeam=new Map();for(let ageGroup of DATA.ageGroups){for(let r of rowsFor(ageGroup)){let team=r.team||"Unattached / Unknown";let item=byTeam.get(team);if(!item){item={team,total:0,counts:DATA.ageGroups.map(()=>0),swimmers:DATA.ageGroups.map(()=>[]),bestRank:Infinity};byTeam.set(team,item)}let idx=DATA.ageGroups.indexOf(ageGroup);item.counts[idx]++;item.swimmers[idx].push({rank:r.rank,name:r.name});item.total++;item.bestRank=Math.min(item.bestRank,r.rank)}}return [...byTeam.values()].sort((a,b)=>b.total-a.total||a.bestRank-b.bestRank||a.team.localeCompare(b.team))}
function teamDistributionRows(){let rows=currentRows();let byTeam=new Map();for(let r of rows){let team=r.team||"Unattached / Unknown";let item=byTeam.get(team);if(!item){item={team,swimmers:[],count:0,bestRank:Infinity,rankTotal:0};byTeam.set(team,item)}item.swimmers.push(r);item.count++;item.bestRank=Math.min(item.bestRank,r.rank);item.rankTotal+=r.rank}return [...byTeam.values()].map(t=>({...t,percent:rows.length?Math.round(t.count*100/rows.length):0,averageRank:t.count?t.rankTotal/t.count:0,ranks:t.swimmers.map(s=>s.rank).sort((a,b)=>a-b)})).sort((a,b)=>b.count-a.count||a.bestRank-b.bestRank||a.averageRank-b.averageRank||a.team.localeCompare(b.team))}
const STROKE_TYPES=[{key:"free",label:"Free",color:"#1d4ed8"},{key:"back",label:"Back",color:"#157347"},{key:"fly",label:"Fly",color:"#996515"},{key:"breast",label:"Breast",color:"#be185d"},{key:"im",label:"IM",color:"#7c3aed"}];
function strokeForEvent(event){let e=String(event||"").toLowerCase();if(e.includes(" im"))return"im";if(e.includes("free"))return"free";if(e.includes("back"))return"back";if(e.includes("fly"))return"fly";if(e.includes("breast"))return"breast";return""}
function refreshStrongTypeTeamSelect(){let select=$("#strongTypeTeamSelect");let teams=teamTrendRows().map(t=>t.team).sort((a,b)=>a.localeCompare(b));let opts=['<option value="">All teams</option>'].concat(teams.map(team=>'<option value="'+esc(team)+'">'+esc(team)+'</option>'));select.innerHTML=opts.join("");if(state.strongTeam&&!teams.includes(state.strongTeam))state.strongTeam="";select.value=state.strongTeam}
function strongTypeRows(){let selectedTeam=state.strongTeam;return DATA.ageGroups.map(ageGroup=>{let byStroke=new Map(STROKE_TYPES.map(s=>[s.key,new Map()]));for(let r of rowsFor(ageGroup)){if(selectedTeam&&r.team!==selectedTeam)continue;for(let e of r.events||[]){let stroke=strokeForEvent(e.event);if(!stroke||!e.swim||!e.rank||e.rank>10)continue;let swimmers=byStroke.get(stroke);let id=String(r.personKey||r.name+"|"+r.team);let swimmer=swimmers.get(id);if(!swimmer){swimmer={rank:r.rank,name:r.name,team:r.team,events:[]};swimmers.set(id,swimmer)}swimmer.events.push({event:e.event,rank:e.rank,time:e.swim.time})}}let segments=STROKE_TYPES.map(stroke=>{let swimmers=[...byStroke.get(stroke.key).values()].map(s=>({...s,events:s.events.sort((a,b)=>a.rank-b.rank||a.event.localeCompare(b.event))})).sort((a,b)=>a.rank-b.rank||a.name.localeCompare(b.name));return{...stroke,count:swimmers.length,swimmers}});return{ageGroup,segments,total:segments.reduce((sum,s)=>sum+s.count,0)}})}
function renderStrongTypeChart(){refreshStrongTypeTeamSelect();let rows=strongTypeRows();let w=920,h=320,l=54,r=24,t=24,b=54,iw=w-l-r,ih=h-t-b;let max=Math.max(1,...rows.map(row=>row.total));let x=i=>l+(i+.5)*iw/rows.length;let y=v=>t+(max-v)*ih/max;let barW=Math.min(84,iw/rows.length*.56);let grid=[0,.25,.5,.75,1].map(p=>{let val=Math.round(max*p);let yy=y(val);return '<line class="chart-grid" x1="'+l+'" x2="'+(w-r)+'" y1="'+yy+'" y2="'+yy+'"></line><text class="chart-label" x="'+(l-10)+'" y="'+(yy+4)+'" text-anchor="end">'+val+'</text>'}).join("");let bars=rows.map((row,i)=>{let base=0;let parts=row.segments.map(seg=>{let y1=y(base+seg.count),y0=y(base),height=Math.max(0,y0-y1);base+=seg.count;if(!seg.count)return"";let data=encodeURIComponent(JSON.stringify(seg.swimmers));return '<rect class="stack-bar chart-hover-target" data-team="'+esc(state.strongTeam||"All teams")+'" data-age="'+esc(row.ageGroup)+'" data-stroke="'+esc(seg.label)+'" data-count="'+seg.count+'" data-swimmers="'+esc(data)+'" x="'+(x(i)-barW/2)+'" y="'+y1+'" width="'+barW+'" height="'+height+'" fill="'+seg.color+'"></rect>'}).join("");return '<g>'+parts+'<text class="chart-label" x="'+x(i)+'" y="'+(h-18)+'" text-anchor="middle">'+esc(row.ageGroup)+'</text><text class="chart-label" x="'+x(i)+'" y="'+(y(row.total)-6)+'" text-anchor="middle">'+row.total+'</text></g>'}).join("");let legend=STROKE_TYPES.map(s=>'<span><i style="background:'+s.color+'"></i>'+esc(s.label)+'</span>').join("");let title=state.strongTeam?state.strongTeam:"all teams";$("#strongTypeChart").innerHTML='<div class="chart-wrap"><svg class="team-line-chart" viewBox="0 0 '+w+' '+h+'" role="img" aria-label="Strong swimmer type counts by stroke and age group"><rect x="0" y="0" width="'+w+'" height="'+h+'" fill="white"></rect>'+grid+'<line class="chart-axis" x1="'+l+'" x2="'+(w-r)+'" y1="'+(h-b)+'" y2="'+(h-b)+'"></line><line class="chart-axis" x1="'+l+'" x2="'+l+'" y1="'+t+'" y2="'+(h-b)+'"></line>'+bars+'<text class="chart-label" x="'+(w/2)+'" y="'+(h-2)+'" text-anchor="middle">Age group</text><text class="chart-label" transform="translate(14 '+(h/2)+') rotate(-90)" text-anchor="middle">Strong swimmers</text></svg></div><div class="strong-legend">'+legend+'</div><div class="muted" style="margin-top:8px;font-size:12px">Showing '+esc(title)+' · '+genderLabel()+' · swimmers in the top 10 of at least one event for each stroke type. A swimmer may count in multiple stroke types.</div><div id="chartTooltip" class="chart-tooltip"></div>'}
function renderTeamTrendChart(){let allTeams=teamTrendRows();let teams=allTeams.filter(team=>team.total>=TEAM_TREND_MIN_SWIMMERS);let ageGroups=DATA.ageGroups;let colors=["#1d4ed8","#157347","#b42318","#996515","#7c3aed","#0f766e","#c2410c","#be185d","#334155","#0891b2","#4d7c0f","#9333ea"];let w=920,h=320,l=54,r=24,t=24,b=48,iw=w-l-r,ih=h-t-b;let max=Math.max(1,...teams.flatMap(team=>team.counts));let x=i=>l+(ageGroups.length===1?iw/2:i*iw/(ageGroups.length-1));let y=v=>t+(max-v)*ih/max;let grid=[0,.25,.5,.75,1].map(p=>{let val=Math.round(max*p);let yy=y(val);return '<line class="chart-grid" x1="'+l+'" x2="'+(w-r)+'" y1="'+yy+'" y2="'+yy+'"></line><text class="chart-label" x="'+(l-10)+'" y="'+(yy+4)+'" text-anchor="end">'+val+'</text>'}).join("");let xLabels=ageGroups.map((g,i)=>'<text class="chart-label" x="'+x(i)+'" y="'+(h-16)+'" text-anchor="middle">'+esc(g)+'</text>').join("");let lines=teams.map((team,i)=>{let color=colors[i%colors.length];let points=team.counts.map((count,idx)=>x(idx)+","+y(count)).join(" ");let cls=i<12?"chart-team-line":"chart-team-line minor";let attrs=' data-team="'+esc(team.team)+'" data-counts="'+esc(team.counts.join("|"))+'" data-total="'+team.total+'"';let dots=team.counts.map((count,idx)=>{let swimmerData=encodeURIComponent(JSON.stringify((team.swimmers[idx]||[]).sort((a,b)=>a.rank-b.rank)));let dotClass="chart-dot chart-hover-target"+(i<12?"":" minor-dot");return '<circle class="'+dotClass+'"'+attrs+' data-age="'+esc(ageGroups[idx])+'" data-count="'+count+'" data-swimmers="'+esc(swimmerData)+'" cx="'+x(idx)+'" cy="'+y(count)+'" r="3.5" fill="'+color+'"></circle>'}).join("");return '<g class="chart-series"><polyline class="'+cls+'" points="'+points+'" stroke="'+color+'"></polyline><polyline class="chart-hit-line chart-hover-target"'+attrs+' points="'+points+'"></polyline>'+dots+'</g>'}).join("");let legend=teams.map((team,i)=>'<span class="legend-item"><span class="legend-swatch" style="background:'+colors[i%colors.length]+'"></span>'+esc(team.team)+' ('+team.total+')</span>').join("");let hiddenCount=allTeams.length-teams.length;$("#teamTrendCount").textContent=teams.length+" teams with "+TEAM_TREND_MIN_SWIMMERS+"+ swimmers · "+hiddenCount+" hidden · "+genderLabel()+" · top 50 per age group";$("#teamTrendChart").innerHTML=teams.length?'<div class="chart-wrap"><svg class="team-line-chart" viewBox="0 0 '+w+' '+h+'" role="img" aria-label="Top 50 swimmer counts by team and age group"><rect x="0" y="0" width="'+w+'" height="'+h+'" fill="white"></rect>'+grid+'<line class="chart-axis" x1="'+l+'" x2="'+(w-r)+'" y1="'+(h-b)+'" y2="'+(h-b)+'"></line><line class="chart-axis" x1="'+l+'" x2="'+l+'" y1="'+t+'" y2="'+(h-b)+'"></line>'+lines+xLabels+'<text class="chart-label" x="'+(w/2)+'" y="'+(h-2)+'" text-anchor="middle">Age group</text><text class="chart-label" transform="translate(14 '+(h/2)+') rotate(-90)" text-anchor="middle">Top 50 swimmers</text></svg></div><div class="chart-legend">'+legend+'</div><div id="chartTooltip" class="chart-tooltip"></div>':'<div class="empty">No teams have at least '+TEAM_TREND_MIN_SWIMMERS+' top-50 swimmers for this gender.</div>'}
function chartTooltipHtml(target){let team=esc(target.dataset.team||"");if(target.dataset.swimmers){let swimmers=[];try{swimmers=JSON.parse(decodeURIComponent(target.dataset.swimmers||"%5B%5D"))}catch{}let list=swimmers.length?swimmers.map(s=>{let events=s.events?": "+s.events.map(e=>esc(e.event)+" #"+esc(e.rank)+(e.time?" · "+esc(e.time):"")).join(", "):"";return "#"+esc(s.rank)+" "+esc(s.name)+events}).join("<br>"):"No swimmers for this point.";let stroke=target.dataset.stroke?" · "+esc(target.dataset.stroke):"";return '<strong>'+team+'</strong><span>'+esc(target.dataset.age||"")+" "+genderLabel()+stroke+'</span><br><span>'+list+'</span>'}let counts=String(target.dataset.counts||"").split("|");let countLine=DATA.ageGroups.map((g,i)=>esc(g)+": "+esc(counts[i]||"0")).join(" · ");return '<strong>'+team+'</strong><span>'+countLine+'</span>'}
function moveChartTooltip(e){let tip=$("#chartTooltip");if(!tip||tip.style.display!=="block")return;let maxLeft=(window.innerWidth||1200)-300;let maxTop=(window.innerHeight||800)-90;tip.style.left=Math.max(8,Math.min(maxLeft,e.clientX+14))+"px";tip.style.top=Math.max(8,Math.min(maxTop,e.clientY+14))+"px"}
function nearestChartDot(target,e){if(target.dataset.swimmers||!target.classList.contains("chart-hit-line"))return target;let svg=target.closest("svg");let series=target.closest(".chart-series");if(!svg||!series||!e)return target;let pt=svg.createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;let cursor=pt.matrixTransform(svg.getScreenCTM().inverse());let best=null,bestDist=Infinity;series.querySelectorAll(".chart-dot[data-swimmers]").forEach(dot=>{let dx=Number(dot.getAttribute("cx"))-cursor.x;let dy=Number(dot.getAttribute("cy"))-cursor.y;let dist=Math.hypot(dx,dy);if(dist<bestDist){best=dot;bestDist=dist}});return best||target}
function showChartTooltip(target,e){let tip=$("#chartTooltip");if(!tip||!target)return;target=nearestChartDot(target,e);tip.innerHTML=chartTooltipHtml(target);tip.style.display="block";$("#teamTrendChart").classList.toggle("chart-focused",true);document.querySelectorAll(".chart-series.active").forEach(g=>g.classList.toggle("active",false));let series=target.closest(".chart-series");if(series)series.classList.toggle("active",true);moveChartTooltip(e)}
function hideChartTooltip(){let tip=$("#chartTooltip");if(tip)tip.style.display="none";$("#teamTrendChart").classList.toggle("chart-focused",false);document.querySelectorAll(".chart-series.active").forEach(g=>g.classList.toggle("active",false))}
function clearLegendFocus(){document.querySelectorAll(".legend-item.active").forEach(x=>x.classList.toggle("active",false))}
function focusLegendItem(item){let items=[...item.parentElement.querySelectorAll(".legend-item")];let idx=items.indexOf(item);let series=[...document.querySelectorAll("#teamTrendChart .chart-series")];if(idx<0||!series[idx])return;let tip=$("#chartTooltip");if(tip)tip.style.display="none";$("#teamTrendChart").classList.toggle("chart-focused",true);document.querySelectorAll(".chart-series.active").forEach(g=>g.classList.toggle("active",false));clearLegendFocus();series[idx].classList.toggle("active",true);item.classList.toggle("active",true)}
function renderTeamDistribution(){let teams=teamDistributionRows();let topCount=Math.min(LIMIT,currentAll().length);let maxCount=Math.max(1,...teams.map(t=>t.count));$("#teamDistributionCount").textContent=teams.length+" teams · top "+topCount+" swimmers";$("#teamDistributionBody").innerHTML=teams.length?teams.map(t=>{let width=Math.round(t.count*100/maxCount);let rankText=t.ranks.map(r=>"#"+r).join(", ");let dots=t.swimmers.map(s=>'<span class="rank-dot" style="left:'+Math.max(0,Math.min(100,((s.rank-1)/Math.max(1,LIMIT-1))*100))+'%" title="'+esc("#"+s.rank+" "+s.name)+'"></span>').join("");return '<button class="team-row" data-team="'+esc(t.team)+'"><span class="team-name"><strong>'+esc(t.team)+'</strong><small>'+t.count+' of '+topCount+' swimmers · '+t.percent+'% · best rank #'+t.bestRank+' · avg rank '+t.averageRank.toFixed(1)+'</small></span><span><span class="team-count">'+t.count+' swimmers</span><span class="team-bar-track"><span class="team-bar-fill" style="width:'+width+'%"></span></span></span><span class="rank-strip-wrap"><small>Ranks '+esc(rankText)+'</small><span class="rank-strip">'+dots+'</span></span></button>'}).join(""):'<div class="empty">No team distribution loaded for this age group and gender.</div>'}
function renderTabs(){$("#swimmersTab").classList.toggle("active",state.tab==="swimmers");$("#teamsTab").classList.toggle("active",state.tab==="teams");$("#swimmersView").classList.toggle("active",state.tab==="swimmers");$("#teamsView").classList.toggle("active",state.tab==="teams")}
function render(){document.body.classList.toggle("mobile-detail-open",state.mobileDetail);renderTabs();refreshSwimmerSelect();let rows=filteredRows();$("#applicantCount").textContent=rows.length+" of top "+Math.min(LIMIT,currentAll().length)+" swimmers";$("#disclaimerMeta").textContent=state.ageGroup+" "+genderLabel()+" · loaded "+fmtDateTime(DATA.lastLoadedAt||DATA.lastUpdated||DATA.generatedAt)+" · "+(DATA.source||"--")+" · public";renderTeamTrendChart();renderStrongTypeChart();renderTeamDistribution();renderTable(rows);renderDetail()}
function renderTable(rows){$("#rankingBody").innerHTML=rows.length?rows.map(r=>'<tr data-name="'+esc(r.name)+'" class="'+(state.detail.type==="swimmer"&&state.detail.name===r.name?"selected-row":"")+'"><td><strong>'+r.rank+'</strong><span class="rank-change '+rankChangeClass(r)+'">'+rankChangeText(r)+'</span></td><td><button class="text-link swimmer-link" data-name="'+esc(r.name)+'"><strong>'+esc(r.name)+'</strong></button><br><small>'+esc(r.age)+' years old</small></td><td><button class="text-link team-link" data-team="'+esc(r.team)+'">'+esc(r.team)+'</button></td><td><strong>'+(r.score>=999?"Incomplete":r.score)+'</strong><br><small>'+r.pp+' PP</small></td><td><div class="event-list">'+r.topSix.map(pill).join("")+'</div></td><td><button class="text-link tie-link" data-name="'+esc(r.name)+'">LCM AAA '+r.cuts.lcmAAA+'<br>SCY AAA '+r.cuts.scyAAA+'</button></td><td><span class="pill '+statusClass(r.status)+'">'+esc(r.status)+'</span></td></tr>').join(""):'<tr><td colspan="7"><div class="empty">No swimmers are loaded for this age group and gender yet.</div></td></tr>'}
function pill(e){return '<button class="pill event-link" data-event="'+esc(e.event)+'">'+esc(e.event)+' #'+e.rank+' · '+esc(e.swim.time)+' · '+fmtDate(e.swim.date)+'</button>'}
function renderDetail(){if(state.detail.type==="team")return renderTeam(state.detail.team);if(state.detail.type==="event")return renderEvent(state.detail.event);if(state.detail.type==="tie")return renderTie(state.detail.name);if(state.detail.type==="swimmer")return renderSwimmer(state.detail.name);renderEmptyDetail()}
function renderEmptyDetail(){$("#detailTitle").textContent="Details";$("#detailBody").innerHTML='<p class="muted">Select a swimmer, team, scoring event, or AAA / Tie value from the ranking table.</p>'}
function findSwimmer(name){return currentRows().find(x=>x.name===name)||currentRows()[0]}
function renderSwimmer(name){let r=findSwimmer(name);if(!r){$("#detailTitle").textContent="Swimmer Detail";$("#detailBody").innerHTML='<p class="muted">No swimmer selected.</p>';return}$("#detailTitle").textContent=r.name;let top=new Set(r.topSix.map(e=>e.event));let events=r.events.slice().sort((a,b)=>(a.rank??999)-(b.rank??999)||DATA.eventOrder.indexOf(a.event)-DATA.eventOrder.indexOf(b.event));$("#detailBody").innerHTML=metrics(r)+'<h3>Zone Ranking Events</h3><p class="muted">One best qualifying LCM time per event, ordered from this swimmer\\'s strongest event rank to weakest.</p>'+events.map(e=>eventCard(e,top.has(e.event))).join("")}
function metrics(r){return '<div class="metric-grid"><div class="metric"><span class="label">Overall Rank</span><strong>'+r.rank+'</strong><span class="pill '+statusClass(r.status)+'">'+esc(r.status)+'</span></div><div class="metric"><span class="label">Score</span><strong>'+(r.score>=999?"Incomplete":r.score)+'</strong><small>six best ranks</small></div><div class="metric"><span class="label">Tie Cuts</span><strong>'+r.cuts.lcmAAA+'/'+r.cuts.scyAAA+'</strong><small>LCM AAA / SCY AAA</small></div><div class="metric"><span class="label">Ranking PP</span><strong>'+r.pp+'</strong><small>top-six ranking events</small></div></div>'}
function eventCard(e,scoring){if(!e.swim)return '<div class="swim-card"><h3>'+esc(e.event)+'</h3><div class="swim-meta">No qualifying LCM time loaded for this Zone ranking event.</div></div>';return '<div class="swim-card"><h3>'+esc(e.event)+(e.rank?', event rank #'+e.rank:'')+' '+(scoring?'<span class="pill selected">Scoring</span>':'')+'</h3><div class="swim-meta">'+esc(e.swim.course)+' '+esc(e.swim.time)+' · '+e.swim.pp+' power points · '+esc(e.swim.std||"standard unknown")+'<br>'+fmtDate(e.swim.date)+' · '+esc(e.swim.meet||"meet unknown")+'</div></div>'}
function renderTeam(team){let rows=currentRows().filter(r=>r.team===team);$("#detailTitle").textContent=team;$("#detailBody").innerHTML='<div class="metric-grid"><div class="metric"><span class="label">Team Swimmers</span><strong>'+rows.length+'</strong><small>top 50 view</small></div><div class="metric"><span class="label">Best Rank</span><strong>'+(rows[0]?.rank||"--")+'</strong><small>'+esc(rows[0]?.name||"")+'</small></div></div><h3>Team Ranking Summary</h3><div class="mini-table">'+rows.map(r=>'<button class="mini-row swimmer-summary-row" data-name="'+esc(r.name)+'"><span><strong>#'+r.rank+' '+esc(r.name)+'</strong><small>'+(r.score>=999?"Incomplete":"score "+r.score)+' · '+r.pp+' PP</small></span><span>LCM '+r.cuts.lcmAAA+'<br>SCY '+r.cuts.scyAAA+'</span></button>').join("")+'</div>'}
function renderEvent(event){let rows=currentRows().map(r=>({r,d:r.events.find(e=>e.event===event)})).filter(x=>x.d?.swim).sort((a,b)=>a.d.rank-b.d.rank);$("#detailTitle").textContent=event+" Rankings";$("#detailBody").innerHTML='<div class="metric-grid"><div class="metric"><span class="label">Event</span><strong>'+esc(event)+'</strong><small>LCM best times only</small></div><div class="metric"><span class="label">Shown</span><strong>'+rows.length+'</strong><small>top 50 swimmers</small></div></div><h3>Event Ranking</h3><div class="mini-table">'+rows.map(x=>'<button class="mini-row swimmer-summary-row" data-name="'+esc(x.r.name)+'"><span><strong>#'+x.d.rank+' '+esc(x.r.name)+'</strong><small>'+esc(x.r.team)+'</small></span><span><strong>'+esc(x.d.swim.time)+'</strong><br><small>'+fmtDate(x.d.swim.date)+'</small></span></button><div class="mini-note">'+esc(x.d.swim.meet||"meet unknown")+' · '+x.d.swim.pp+' PP · '+esc(x.d.swim.std||"standard unknown")+'</div>').join("")+'</div>'}
function renderTie(name){let r=findSwimmer(name);if(!r)return renderEmptyDetail();$("#detailTitle").textContent=r.name+" AAA / Tie";$("#detailBody").innerHTML=metrics(r)+'<h3>All AAA / Tie-Break Times</h3>'+(r.ties.length?r.ties.map(t=>'<div class="swim-card"><h3>'+esc(t.swim.event)+' · '+esc(t.type)+'</h3><div class="swim-meta">'+esc(t.swim.course)+' '+esc(t.swim.time)+' · '+t.swim.pp+' power points · '+esc(t.swim.std||"standard unknown")+'<br>'+fmtDate(t.swim.date)+' · '+esc(t.swim.meet||"meet unknown")+'</div></div>').join(""):'<p class="muted">No tie-break times loaded.</p>')}
$("#ageGroupSelect").addEventListener("change",e=>{state.ageGroup=e.target.value;state.selected="";state.detail={type:"none"};state.mobileDetail=false;render()});
$("#genderSelect").addEventListener("change",e=>{state.gender=e.target.value;state.selected="";state.detail={type:"none"};state.mobileDetail=false;render()});
$("#swimmerSelect").addEventListener("change",e=>{state.selected=e.target.value;state.detail=e.target.value?{type:"swimmer",name:e.target.value}:{type:"none"};state.mobileDetail=Boolean(e.target.value);render()});
$("#strongTypeTeamSelect").addEventListener("change",e=>{state.strongTeam=e.target.value;render()});
$("#backToRankings").addEventListener("click",()=>{state.mobileDetail=false;render();window.scrollTo({top:0,behavior:"smooth"})});
$("#resetDetail").addEventListener("click",()=>{state.selected="";state.detail={type:"none"};state.mobileDetail=false;$("#swimmerSelect").value="";render()});
document.querySelectorAll("[data-tab]").forEach(btn=>btn.addEventListener("click",()=>{state.tab=btn.dataset.tab;state.mobileDetail=false;render()}));
$("#rankingBody").addEventListener("click",e=>{let t=e.target.closest("[data-name],[data-team],[data-event]");if(!t){let tr=e.target.closest("tr");if(tr)t=tr}if(!t)return;if(t.classList.contains("team-link"))state.detail={type:"team",team:t.dataset.team};else if(t.classList.contains("event-link"))state.detail={type:"event",event:t.dataset.event};else if(t.classList.contains("tie-link"))state.detail={type:"tie",name:t.dataset.name};else state.detail={type:"swimmer",name:t.dataset.name};state.mobileDetail=true;render();window.scrollTo({top:0,behavior:"smooth"})});
$("#teamTrendChart").addEventListener("mouseover",e=>{let item=e.target.closest(".legend-item");if(!item)return;focusLegendItem(item)});
$("#teamTrendChart").addEventListener("mousemove",e=>{let t=e.target.closest(".chart-hover-target");if(!t)return;clearLegendFocus();showChartTooltip(t,e)});
$("#teamTrendChart").addEventListener("mouseleave",()=>{hideChartTooltip();clearLegendFocus()});
$("#teamTrendChart").addEventListener("touchstart",e=>{let t=e.target.closest(".chart-hover-target");if(!t)return;showChartTooltip(t,e.touches[0]||e)}, {passive:true});
$("#strongTypeChart").addEventListener("mousemove",e=>{let t=e.target.closest(".chart-hover-target");if(!t)return;showChartTooltip(t,e)});
$("#strongTypeChart").addEventListener("mouseleave",()=>hideChartTooltip());
$("#strongTypeChart").addEventListener("touchstart",e=>{let t=e.target.closest(".chart-hover-target");if(!t)return;showChartTooltip(t,e.touches[0]||e)}, {passive:true});
$("#teamDistributionBody").addEventListener("click",e=>{let t=e.target.closest("[data-team]");if(!t)return;state.selected="";state.tab="swimmers";state.detail={type:"team",team:t.dataset.team};state.mobileDetail=true;render();window.scrollTo({top:0,behavior:"smooth"})});
$("#detailBody").addEventListener("click",e=>{let t=e.target.closest(".swimmer-summary-row[data-name]");if(!t)return;state.detail={type:"swimmer",name:t.dataset.name};state.mobileDetail=true;render();window.scrollTo({top:0,behavior:"smooth"})});
setupControls();render();
</script>
</body>
</html>`;
}
