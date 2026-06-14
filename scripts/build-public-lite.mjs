#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const INPUT = path.join(ROOT, "data", "swimmers.json");
const OUTPUT = process.env.PUBLIC_DASHBOARD_OUTPUT ||
  (path.basename(ROOT) === "western-zone-dashboard"
    ? path.resolve(ROOT, "..", "western-zone-dashboard-public", "index.html")
    : path.join(ROOT, "index.html"));
const TARGET = "Ethan Wang";
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
const swimmers = (source.swimmers || []).map(normalizeSwimmer);
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
  target: TARGET,
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
    const match = html.match(/const DATA=(.*?);\nconst TARGET=/s);
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
    name: r.name,
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
:root{--ink:#17202a;--muted:#64748b;--line:#d7dee8;--paper:#fff;--band:#f4f7fb;--green:#157347;--gold:#996515;--red:#b42318;--blue:#1d4ed8}*{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:#eef3f8}button,select{font:inherit}header{padding:22px 28px;color:#fff;background:#123447}h1,h2,p{margin-top:0}h1{margin-bottom:0;font-size:28px}.eyebrow{margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#bde8ef}main{max-width:1480px;margin:0 auto;padding:20px}.status-band{display:grid;grid-template-columns:repeat(4,1fr);margin-bottom:16px;border:1px solid var(--line);background:var(--paper)}.status-band>div{padding:16px;border-right:1px solid var(--line)}.status-band>div:last-child{border-right:0}.label,small,.muted{color:var(--muted)}.label{display:block;margin-bottom:4px;font-size:12px;font-weight:700;text-transform:uppercase}.status-band strong{display:block;font-size:24px}.controls{display:grid;grid-template-columns:180px 160px minmax(260px,1fr);gap:12px;margin-bottom:16px;padding:14px;border:1px solid var(--line);background:var(--band)}.field label{display:block;margin-bottom:5px;font-size:12px;font-weight:700;color:var(--muted)}.field select{width:100%;height:40px;border:1px solid var(--line);border-radius:6px;padding:0 10px;background:white}.content-grid{display:grid;grid-template-columns:minmax(0,1fr) 430px;gap:16px;margin-bottom:16px}.rank-panel,.detail-panel,.rules-panel{border:1px solid var(--line);background:var(--paper)}.panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}.panel-head h2{margin:0}.panel-actions{display:flex;align-items:center;gap:8px}.panel-head button{border:1px solid var(--line);border-radius:6px;padding:8px 12px;background:var(--band);color:var(--ink);font-weight:700;cursor:pointer}.mobile-back{display:none}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:860px}th,td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);text-transform:uppercase;background:#f8fafc}tbody tr{cursor:pointer}tbody tr:hover{background:#f5fbfc}tbody tr.selected-row{background:#e8f6f7}.rank-change{display:block;margin-top:2px;font-size:12px;font-weight:700}.rank-up{color:var(--green)}.rank-down{color:var(--red)}.rank-new{color:var(--blue)}.rank-same{color:var(--muted)}.pill{display:inline-flex;align-items:center;min-height:24px;border:0;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:700;white-space:nowrap;background:#e2e8f0;color:#334155}.pill.selected{background:#d1fae5;color:var(--green)}.pill.alternate{background:#fef3c7;color:var(--gold)}.pill.outside{background:#fee2e2;color:var(--red)}.pill.ethan{background:#dbeafe;color:var(--blue)}.event-list{display:flex;flex-wrap:wrap;gap:5px}.text-link{display:inline;border:0;border-radius:0;padding:0;background:transparent;color:inherit;font-weight:inherit;text-align:left;cursor:pointer}.event-link:hover,.text-link:hover{text-decoration:underline}.detail-body{padding:16px}.metric-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px}.metric{padding:10px;border:1px solid var(--line);background:#f8fafc}.metric strong{display:block;font-size:20px}.swim-card{padding:10px 0;border-top:1px solid var(--line)}.swim-card:first-of-type{border-top:0}.swim-card h3{margin:0 0 5px;font-size:15px}.swim-meta{color:var(--muted);font-size:13px;line-height:1.45}.mini-table{border-top:1px solid var(--line)}.mini-row{display:flex;width:100%;justify-content:space-between;gap:12px;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:10px 0;background:transparent;color:var(--ink);text-align:left;cursor:pointer}.mini-row:hover{background:#f8fafc}.mini-row span:last-child{text-align:right;white-space:nowrap}.mini-row small{display:block;margin-top:2px}.mini-note{margin:-7px 0 7px;padding-bottom:8px;border-bottom:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.4}.rules-panel{padding:16px 18px}.rules-panel li{margin-bottom:8px;line-height:1.45}.empty{padding:24px;color:var(--muted)}@media(max-width:980px){.status-band,.controls,.content-grid{grid-template-columns:1fr}.status-band>div{border-right:0;border-bottom:1px solid var(--line)}.status-band>div:last-child{border-bottom:0}}@media(max-width:700px){header{padding:16px}h1{font-size:22px}main{padding:10px}.status-band strong{font-size:20px}.controls{padding:10px;gap:10px}.table-wrap{overflow-x:auto}.detail-panel{display:none}.mobile-detail-open .rank-panel,.mobile-detail-open .rules-panel{display:none}.mobile-detail-open .detail-panel{display:block}.mobile-detail-open .controls{display:none}.mobile-back{display:inline-flex}.panel-head{position:sticky;top:0;z-index:2;background:var(--paper)}.panel-head h2{font-size:18px}.metric-grid{grid-template-columns:1fr}.mini-row{align-items:flex-start}.detail-body{padding:14px}}
</style>
</head>
<body>
<header><p class="eyebrow">Team Pacific Northwest</p><h1>Western Zone Ranking Dashboard</h1></header>
<main>
<section class="status-band"><div><span class="label">Target athlete</span><strong>Ethan Wang</strong><small>PDST, Pacific Northwest LSC</small></div><div><span class="label">Ethan rank</span><strong id="targetRank">--</strong><small id="targetRankStatus">--</small></div><div><span class="label">Ethan score</span><strong id="targetScore">--</strong><small>sum of 6 best event ranks</small></div><div><span class="label">Last loaded</span><strong id="lastUpdated">--</strong><small id="dataSource">--</small></div></section>
<section class="controls"><div class="field"><label for="ageGroupSelect">Age Group</label><select id="ageGroupSelect"></select></div><div class="field"><label for="genderSelect">Gender</label><select id="genderSelect"></select></div><div class="field"><label for="swimmerSelect">Swimmer</label><select id="swimmerSelect"></select></div></section>
<section class="content-grid"><div class="rank-panel"><div class="panel-head"><h2>Top 50 Ranking Pool</h2><span id="applicantCount">0 swimmers</span></div><div class="table-wrap"><table><thead><tr><th>Rank</th><th>Swimmer</th><th>Team</th><th>Score</th><th>6 Scoring Events</th><th>AAA / Tie</th><th>Status</th></tr></thead><tbody id="rankingBody"></tbody></table></div></div><aside class="detail-panel"><div class="panel-head"><h2 id="detailTitle">Swimmer Detail</h2><div class="panel-actions"><button id="backToRankings" class="mobile-back" type="button">Rankings</button><button id="resetDetail" type="button" title="Show target athlete">Target</button></div></div><div id="detailBody" class="detail-body"></div></aside></section>
<section class="rules-panel"><h2>Selection Factors Implemented</h2><ul><li>Default view is 11-12 Male, top 50 swimmers.</li><li>Ranking events are LCM 50/100/200 free, back, breast, fly; 200 IM; 400 free; and 400 IM.</li><li>Eligible times are July 1, 2025 through July 25, 2026.</li><li>Primary score is the sum of each applicant's six best relative event ranks. Lowest score ranks highest.</li><li>Tie-break priority: more LCM AAA times, then more SCY AAA times, then higher power-point total for the six ranking events.</li></ul></section>
</main>
<script>
const DATA=${json};
const TARGET=DATA.target;
const LIMIT=50;
let state={ageGroup:DATA.defaultAgeGroup,gender:DATA.defaultGender,selected:"",detail:{type:"swimmer",name:TARGET},mobileDetail:false};
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
function setupControls(){DATA.ageGroups.forEach(g=>$("#ageGroupSelect").insertAdjacentHTML("beforeend",'<option value="'+esc(g)+'">'+esc(g)+'</option>'));DATA.genders.forEach(g=>$("#genderSelect").insertAdjacentHTML("beforeend",'<option value="'+esc(g.value)+'">'+esc(g.label)+'</option>'));$("#ageGroupSelect").value=state.ageGroup;$("#genderSelect").value=state.gender}
function refreshSwimmerSelect(){let rows=currentRows();let opts=['<option value="">All 50 swimmers</option>'].concat(rows.map(r=>'<option value="'+esc(r.name)+'">'+esc("#"+r.rank+" "+r.name)+'</option>'));$("#swimmerSelect").innerHTML=opts.join("");$("#swimmerSelect").value=state.selected||""}
function filteredRows(){let rows=currentRows();return state.selected?rows.filter(r=>r.name===state.selected):rows}
function render(){document.body.classList.toggle("mobile-detail-open",state.mobileDetail);refreshSwimmerSelect();let rows=filteredRows();$("#applicantCount").textContent=rows.length+" of top "+Math.min(LIMIT,currentAll().length)+" swimmers";$("#lastUpdated").textContent=fmtDateTime(DATA.lastLoadedAt||DATA.lastUpdated||DATA.generatedAt);$("#dataSource").textContent=rankSummaryText()+" · "+(DATA.source||"--")+" · public";renderTable(rows);renderEthan();renderDetail()}
function renderTable(rows){$("#rankingBody").innerHTML=rows.length?rows.map(r=>'<tr data-name="'+esc(r.name)+'" class="'+(state.detail.type==="swimmer"&&state.detail.name===r.name?"selected-row":"")+'"><td><strong>'+r.rank+'</strong><span class="rank-change '+rankChangeClass(r)+'">'+rankChangeText(r)+'</span></td><td><button class="text-link swimmer-link" data-name="'+esc(r.name)+'"><strong>'+esc(r.name)+'</strong></button> '+(r.name===TARGET?'<span class="pill ethan">Ethan</span>':'')+'<br><small>'+esc(r.age)+' years old</small></td><td><button class="text-link team-link" data-team="'+esc(r.team)+'">'+esc(r.team)+'</button></td><td><strong>'+(r.score>=999?"Incomplete":r.score)+'</strong><br><small>'+r.pp+' PP</small></td><td><div class="event-list">'+r.topSix.map(pill).join("")+'</div></td><td><button class="text-link tie-link" data-name="'+esc(r.name)+'">LCM AAA '+r.cuts.lcmAAA+'<br>SCY AAA '+r.cuts.scyAAA+'</button></td><td><span class="pill '+statusClass(r.status)+'">'+esc(r.status)+'</span></td></tr>').join(""):'<tr><td colspan="7"><div class="empty">No swimmers are loaded for this age group and gender yet.</div></td></tr>'}
function pill(e){return '<button class="pill event-link" data-event="'+esc(e.event)+'">'+esc(e.event)+' #'+e.rank+' · '+esc(e.swim.time)+' · '+fmtDate(e.swim.date)+'</button>'}
function renderEthan(){let ethan=(DATA.groups["11-12|M"]||[]).find(r=>r.name===TARGET);if(!ethan){$("#targetRank").textContent="--";$("#targetRankStatus").textContent="not loaded";$("#targetScore").textContent="--";return}$("#targetRank").textContent="#"+ethan.rank;$("#targetRankStatus").textContent=ethan.status+" · "+rankChangeText(ethan)+" · 11-12 Male · "+ethan.topSix.length+"/6 scoring events";$("#targetScore").textContent=ethan.score>=999?"Incomplete":ethan.score}
function renderDetail(){if(state.detail.type==="team")return renderTeam(state.detail.team);if(state.detail.type==="event")return renderEvent(state.detail.event);if(state.detail.type==="tie")return renderTie(state.detail.name);renderSwimmer(state.detail.name||TARGET)}
function findSwimmer(name){return currentAll().find(x=>x.name===name)||(DATA.groups["11-12|M"]||[]).find(x=>x.name===name)||currentRows()[0]}
function renderSwimmer(name){let r=findSwimmer(name);if(!r){$("#detailTitle").textContent="Swimmer Detail";$("#detailBody").innerHTML='<p class="muted">No swimmer selected.</p>';return}$("#detailTitle").textContent=r.name;let top=new Set(r.topSix.map(e=>e.event));let events=r.events.slice().sort((a,b)=>(a.rank??999)-(b.rank??999)||DATA.eventOrder.indexOf(a.event)-DATA.eventOrder.indexOf(b.event));$("#detailBody").innerHTML=metrics(r)+'<h3>Zone Ranking Events</h3><p class="muted">One best qualifying LCM time per event, ordered from this swimmer\\'s strongest event rank to weakest.</p>'+events.map(e=>eventCard(e,top.has(e.event))).join("")}
function metrics(r){return '<div class="metric-grid"><div class="metric"><span class="label">Overall Rank</span><strong>'+r.rank+'</strong><span class="pill '+statusClass(r.status)+'">'+esc(r.status)+'</span></div><div class="metric"><span class="label">Score</span><strong>'+(r.score>=999?"Incomplete":r.score)+'</strong><small>six best ranks</small></div><div class="metric"><span class="label">Tie Cuts</span><strong>'+r.cuts.lcmAAA+'/'+r.cuts.scyAAA+'</strong><small>LCM AAA / SCY AAA</small></div><div class="metric"><span class="label">Ranking PP</span><strong>'+r.pp+'</strong><small>top-six ranking events</small></div></div>'}
function eventCard(e,scoring){if(!e.swim)return '<div class="swim-card"><h3>'+esc(e.event)+'</h3><div class="swim-meta">No qualifying LCM time loaded for this Zone ranking event.</div></div>';return '<div class="swim-card"><h3>'+esc(e.event)+(e.rank?', event rank #'+e.rank:'')+' '+(scoring?'<span class="pill selected">Scoring</span>':'')+'</h3><div class="swim-meta">'+esc(e.swim.course)+' '+esc(e.swim.time)+' · '+e.swim.pp+' power points · '+esc(e.swim.std||"standard unknown")+'<br>'+fmtDate(e.swim.date)+' · '+esc(e.swim.meet||"meet unknown")+'</div></div>'}
function renderTeam(team){let rows=currentAll().filter(r=>r.team===team).slice(0,LIMIT);$("#detailTitle").textContent=team;$("#detailBody").innerHTML='<div class="metric-grid"><div class="metric"><span class="label">Team Swimmers</span><strong>'+rows.length+'</strong><small>top 50 view</small></div><div class="metric"><span class="label">Best Rank</span><strong>'+(rows[0]?.rank||"--")+'</strong><small>'+esc(rows[0]?.name||"")+'</small></div></div><h3>Team Ranking Summary</h3><div class="mini-table">'+rows.map(r=>'<button class="mini-row swimmer-summary-row" data-name="'+esc(r.name)+'"><span><strong>#'+r.rank+' '+esc(r.name)+'</strong><small>'+(r.score>=999?"Incomplete":"score "+r.score)+' · '+r.pp+' PP</small></span><span>LCM '+r.cuts.lcmAAA+'<br>SCY '+r.cuts.scyAAA+'</span></button>').join("")+'</div>'}
function renderEvent(event){let rows=currentAll().map(r=>({r,d:r.events.find(e=>e.event===event)})).filter(x=>x.d?.swim).sort((a,b)=>a.d.rank-b.d.rank).slice(0,LIMIT);$("#detailTitle").textContent=event+" Rankings";$("#detailBody").innerHTML='<div class="metric-grid"><div class="metric"><span class="label">Event</span><strong>'+esc(event)+'</strong><small>LCM best times only</small></div><div class="metric"><span class="label">Shown</span><strong>'+rows.length+'</strong><small>top 50 swimmers</small></div></div><h3>Event Ranking</h3><div class="mini-table">'+rows.map(x=>'<button class="mini-row swimmer-summary-row" data-name="'+esc(x.r.name)+'"><span><strong>#'+x.d.rank+' '+esc(x.r.name)+'</strong><small>'+esc(x.r.team)+'</small></span><span><strong>'+esc(x.d.swim.time)+'</strong><br><small>'+fmtDate(x.d.swim.date)+'</small></span></button><div class="mini-note">'+esc(x.d.swim.meet||"meet unknown")+' · '+x.d.swim.pp+' PP · '+esc(x.d.swim.std||"standard unknown")+'</div>').join("")+'</div>'}
function renderTie(name){let r=findSwimmer(name);$("#detailTitle").textContent=r.name+" AAA / Tie";$("#detailBody").innerHTML=metrics(r)+'<h3>All AAA / Tie-Break Times</h3>'+(r.ties.length?r.ties.map(t=>'<div class="swim-card"><h3>'+esc(t.swim.event)+' · '+esc(t.type)+'</h3><div class="swim-meta">'+esc(t.swim.course)+' '+esc(t.swim.time)+' · '+t.swim.pp+' power points · '+esc(t.swim.std||"standard unknown")+'<br>'+fmtDate(t.swim.date)+' · '+esc(t.swim.meet||"meet unknown")+'</div></div>').join(""):'<p class="muted">No tie-break times loaded.</p>')}
$("#ageGroupSelect").addEventListener("change",e=>{state.ageGroup=e.target.value;state.selected="";state.detail={type:"swimmer",name:TARGET};state.mobileDetail=false;render()});
$("#genderSelect").addEventListener("change",e=>{state.gender=e.target.value;state.selected="";state.detail={type:"swimmer",name:TARGET};state.mobileDetail=false;render()});
$("#swimmerSelect").addEventListener("change",e=>{state.selected=e.target.value;state.detail=e.target.value?{type:"swimmer",name:e.target.value}:{type:"swimmer",name:TARGET};state.mobileDetail=Boolean(e.target.value);render()});
$("#backToRankings").addEventListener("click",()=>{state.mobileDetail=false;render();window.scrollTo({top:0,behavior:"smooth"})});
$("#resetDetail").addEventListener("click",()=>{state.ageGroup="11-12";state.gender="M";state.selected=TARGET;state.detail={type:"swimmer",name:TARGET};state.mobileDetail=true;$("#ageGroupSelect").value=state.ageGroup;$("#genderSelect").value=state.gender;render()});
$("#rankingBody").addEventListener("click",e=>{let t=e.target.closest("[data-name],[data-team],[data-event]");if(!t){let tr=e.target.closest("tr");if(tr)t=tr}if(!t)return;if(t.classList.contains("team-link"))state.detail={type:"team",team:t.dataset.team};else if(t.classList.contains("event-link"))state.detail={type:"event",event:t.dataset.event};else if(t.classList.contains("tie-link"))state.detail={type:"tie",name:t.dataset.name};else state.detail={type:"swimmer",name:t.dataset.name};state.mobileDetail=true;render();window.scrollTo({top:0,behavior:"smooth"})});
$("#detailBody").addEventListener("click",e=>{let t=e.target.closest(".swimmer-summary-row[data-name]");if(!t)return;state.detail={type:"swimmer",name:t.dataset.name};state.mobileDetail=true;render();window.scrollTo({top:0,behavior:"smooth"})});
setupControls();render();
</script>
</body>
</html>`;
}
