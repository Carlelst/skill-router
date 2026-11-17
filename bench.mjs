#!/usr/bin/env node
// Routing bench: speaks MCP over stdio, measures startup + per-query latency,
// and scores skill_search against a labelled query set.
// Usage: node bench.mjs  (prints JSON summary; exit 1 if hit@3 below threshold)
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "server.mjs");

// gold sets allow synonyms; a case passes if any expected id is in the top-k
const CASES = [
  ["react component re-render performance tuning", ["vercel-react-best-practices", "react"]],
  ["web performance audit lighthouse core web vitals", ["core-web-vitals-performance-contracts"]],
  ["write a prd for a new feature", ["prd-draft", "to-prd"]],
  ["feishu calendar: what meetings do I have today", ["lark-calendar", "wecomcli-schedule"]],
  ["humanize ai sounding english prose", ["humanizer"]],
  ["去 AI 味, 把这段中文改得说人话", ["qu-ai-wei", "humanizer-zh"]],
  ["sql injection and xss security review", ["security-and-hardening", "frontend-security-baseline", "semgrep"]],
  ["flaky integration test hardening", ["test-driven-development", "test-engineer", "tdd"]],
  ["three.js procedural ocean with FFT waves", ["threejs-spectral-ocean"]],
  ["generate a pptx slide deck", ["pptx", "ppt-master", "html-ppt", "ppt-deck-builder"]],
  ["russian plural rules and rtl layout after translation", ["i18n-copy-and-layout"]],
  ["indexeddb write disappeared after reload", ["browser-storage-durability-contracts", "browser-storage"]],
  ["kubernetes deployment architecture diagram", ["diagram", "archify", "fireworks-tech-graph"]],
  ["git rebase conflict resolution workflow", ["git-workflow-and-versioning", "git"]],
  ["debug a node memory leak", ["diagnose", "debugging-and-error-recovery", "deeptrace"]],
  ["design a rest api contract", ["api-and-interface-design"]],
  ["animate a raster logo into svg", ["pixel2motion"]],
  ["static analysis vulnerability scan of a repo", ["semgrep", "codeql", "cso"]],
  ["summarize a youtube video transcript", ["agent-reach", "web-scraper"]],
  ["accessibility role and focus regression tests", ["a11y-contract-testing"]],
];

function rpc(proc, id, method, params) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      proc.stdout.off("data", onData);
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (e) {
        reject(e);
      }
    };
    proc.stdout.on("data", onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const call = (proc, id, name, args) => rpc(proc, id, "tools/call", { name, arguments: args });

const t0 = performance.now();
const proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
await rpc(proc, 1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "bench", version: "1" },
});
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const list = await rpc(proc, 2, "tools/list", {});
const startupMs = performance.now() - t0;
const toolsPayloadBytes = JSON.stringify(list.result).length;

const lat = [];
let hit1 = 0;
let hit3 = 0;
const misses = [];
for (const [i, [query, gold]] of CASES.entries()) {
  const s = performance.now();
  const res = await call(proc, 100 + i, "skill_search", { query, limit: 5 });
  lat.push(performance.now() - s);
  const ids = JSON.parse(res.result.content[0].text).map?.((r) => r.id) ?? [];
  if (gold.includes(ids[0])) hit1++;
  if (ids.slice(0, 3).some((id) => gold.includes(id))) hit3++;
  else misses.push({ query, got: ids.slice(0, 3) });
}
proc.kill();

lat.sort((a, b) => a - b);
const p = (q) => Math.round(lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]);
const summary = {
  cases: CASES.length,
  startupMs: Math.round(startupMs),
  toolsPayloadBytes,
  searchMs: { p50: p(0.5), p95: p(0.95), max: Math.round(lat.at(-1)) },
  hitAt1: `${hit1}/${CASES.length}`,
  hitAt3: `${hit3}/${CASES.length}`,
  hitAt3Pct: Math.round((hit3 / CASES.length) * 100),
  misses,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(hit3 / CASES.length >= 0.8 ? 0 : 1);
