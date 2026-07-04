#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";

const TARGET = "Ethan Wang";
const GROUP = "11-12|M";
const previousPath = process.env.PREVIOUS_DASHBOARD || "/tmp/wz-previous-index.html";
const currentPath = process.env.CURRENT_DASHBOARD || "index.html";
const reportUrl = process.env.REPORT_URL || "https://jialiu103.github.io/western-zone-dashboard/";
const emailTo = process.env.EMAIL_TO || "liujiauestc@gmail.com";

const previous = await readDashboard(previousPath);
const current = await readDashboard(currentPath);
const before = findTarget(previous);
const after = findTarget(current);

if (!after) {
  console.log(`No ${TARGET} row found; no email sent.`);
  process.exit(0);
}

const changed = !before ||
  before.rank !== after.rank ||
  before.score !== after.score ||
  before.status !== after.status;

if (!changed) {
  console.log(`${TARGET} rank unchanged; no email sent.`);
  process.exit(0);
}

const subject = `${TARGET} dashboard changed: ${changeSummary(before, after)}`;
const body = [
  `${TARGET}'s Western Zone dashboard ranking changed.`,
  "",
  `Previous: ${before ? `rank #${before.rank}, score ${formatScore(before.score)}, status ${before.status}` : "not found"}`,
  `Current:  rank #${after.rank}, score ${formatScore(after.score)}, status ${after.status}`,
  `Loaded:   ${current.lastLoadedAt || current.lastUpdated || current.generatedAt || "unknown"}`,
  "",
  `Report: ${reportUrl}`,
  "",
  "Top scoring events:",
  ...(after.topSix || []).map(event => `- ${event.event} #${event.rank}: ${event.swim?.time || "--"} on ${event.swim?.date || "date unknown"}`)
].join("\n");

if (!hasSmtpConfig()) {
  console.log("Ethan rank changed, but SMTP secrets are not configured. Email not sent.");
  console.log(subject);
  console.log(body);
  process.exit(0);
}

await sendSmtpMail({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true").toLowerCase() !== "false",
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.EMAIL_FROM || process.env.SMTP_USER,
  to: emailTo,
  subject,
  body
});

console.log(`Sent ${TARGET} rank-change email to ${emailTo}.`);

async function readDashboard(filePath) {
  try {
    const html = await fs.readFile(filePath, "utf8");
    const match = html.match(/const DATA=(.*?);\nconst TARGET=/s);
    return match ? JSON.parse(match[1]) : null;
  } catch {
    return null;
  }
}

function findTarget(data) {
  return (data?.groups?.[GROUP] || []).find(row => row.name === TARGET) || null;
}

function formatScore(score) {
  return Number(score) >= 999 ? "Incomplete" : score;
}

function changeSummary(before, after) {
  if (!before) return `new rank #${after.rank}`;
  const changes = [];
  if (before.rank !== after.rank) changes.push(`rank #${before.rank} -> #${after.rank}`);
  if (before.score !== after.score) changes.push(`score ${formatScore(before.score)} -> ${formatScore(after.score)}`);
  if (before.status !== after.status) changes.push(`status ${before.status} -> ${after.status}`);
  return changes.join(", ") || `rank #${after.rank}`;
}

function hasSmtpConfig() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && emailTo);
}

async function sendSmtpMail({ host, port, secure, user, pass, from, to, subject, body }) {
  const socket = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  socket.setEncoding("utf8");
  await readUntil(socket, "220");
  await command(socket, `EHLO western-zone-dashboard`, "250");
  await command(socket, "AUTH LOGIN", "334");
  await command(socket, Buffer.from(user).toString("base64"), "334");
  await command(socket, Buffer.from(pass).toString("base64"), "235");
  await command(socket, `MAIL FROM:<${from}>`, "250");
  await command(socket, `RCPT TO:<${to}>`, "250");
  await command(socket, "DATA", "354");
  socket.write(formatMessage({ from, to, subject, body }));
  await readUntil(socket, "250");
  await command(socket, "QUIT", "221");
  socket.end();
}

function formatMessage({ from, to, subject, body }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8"
  ].join("\r\n");
  return `${headers}\r\n\r\n${body.replace(/\n/g, "\r\n")}\r\n.\r\n`;
}

function command(socket, line, expected) {
  socket.write(`${line}\r\n`);
  return readUntil(socket, expected);
}

function readUntil(socket, expected) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) || "";
      if (last.startsWith(expected) && !last.startsWith(`${expected}-`)) {
        cleanup();
        resolve(buffer);
      } else if (/^[45]\d\d/.test(last)) {
        cleanup();
        reject(new Error(last));
      }
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}
