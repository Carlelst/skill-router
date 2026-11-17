#!/usr/bin/env node
// Lazy router over the local Claude Code skill library: search + load SKILL.md
// files by keyword overlap, so a caller can find a skill without scanning
// every directory itself.
import { readFile, readdir, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildIndex, search, closestIds, getIndex, slugify } from "./lib.mjs";

const server = new Server(
  { name: "skill-router", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    // Injected into the agent's system prompt. Search returns pointers only, so the
    // loop has to be stated here or callers stop after one search.
    instructions:
      "Most skills live outside the native list and are only reachable through this server. " +
      "skill_search returns pointers (id/name/description/score), never the skill body. " +
      "Before following a matching skill, call skill_load with its id — batching ids in one call is supported. " +
      "Search with concrete task keywords; retry once with different domain terms if the top hits look wrong.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "skill_search",
      _meta: { "anthropic/alwaysLoad": true }, // local patch: otherwise Claude Code defers it behind ToolSearch
      description:
        "Step 1 of 2. Search the local skill library; returns ranked POINTERS (id, name, description, score), NOT the skill body. You must call skill_load with the chosen id before following it. Use concrete task keywords (e.g. 'web performance audit', 'cold email sequence'), not filler words. If the top results look wrong, retry once with different domain terms.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Concrete task keywords describing what you're trying to do." },
          limit: { type: "number", description: "Max results (default 5, max 20)." },
        },
        required: ["query"],
      },
    },
    {
      name: "skill_load",
      _meta: { "anthropic/alwaysLoad": true }, // local patch: otherwise Claude Code defers it behind ToolSearch
      description:
        "Step 2 of 2. Load the full SKILL.md body for one or more skill ids from skill_search. Without this call you only have a one-line description — never follow a skill you have not loaded. Pass `ids` to load several in one call.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Skill id or name (case-insensitive)." },
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Several skill ids to load in one call; cheaper than one call per skill.",
          },
        },
      },
    },
    {
      name: "skill_reindex",
      description: "Rescan the skill roots and rebuild the index. Returns counts per source.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

// Usage telemetry: the point is to be able to answer "was the search→load loop ever
// completed?" from data instead of memory. Best-effort; logging never breaks a call.
function logUsage(entry) {
  appendFile(
    path.join(homedir(), ".claude/skill-router-usage.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
  ).catch(() => {});
}

async function loadOne(wanted) {
  const index = getIndex();
  let item = index.get(slugify(wanted));
  if (!item) {
    const wantedLower = String(wanted).toLowerCase();
    item = [...index.values()].find((i) => i.name.toLowerCase() === wantedLower);
  }
  if (!item) {
    return { error: `Unknown skill id "${wanted}".`, closest: closestIds(wanted, 5) };
  }
  const dir = path.dirname(item.path);
  let siblings = [];
  try {
    siblings = (await readdir(dir)).filter((f) => f !== "SKILL.md");
  } catch {
    // directory vanished between index and load; siblings stays empty
  }
  let content;
  try {
    content = await readFile(item.path, "utf8");
  } catch {
    return {
      error: `Skill file unreadable at ${item.path} (moved or deleted since indexing). Run skill_reindex and search again.`,
    };
  }
  return { id: item.id, name: item.name, path: item.path, siblings, content };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "skill_search") {
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
    const results = search(String(args.query ?? ""), limit);
    logUsage({ tool: "skill_search", query: String(args.query ?? ""), top: results.slice(0, 3).map((r) => r.id) });
    if (results.length === 0) {
      return textResult({
        message: "No matches. Try broader or different terms.",
        totalIndexed: getIndex().size,
      });
    }
    return textResult(results);
  }

  if (name === "skill_load") {
    const targets = Array.isArray(args.ids) && args.ids.length
      ? args.ids.map(String)
      : [String(args.id ?? "")];
    if (!targets[0]) {
      return textResult({ error: "Pass `id` or a non-empty `ids` array." });
    }
    const loaded = [];
    for (const t of targets) loaded.push(await loadOne(t));
    logUsage({ tool: "skill_load", ids: targets, ok: loaded.every((r) => !r.error) });
    return textResult(loaded.length === 1 ? loaded[0] : loaded);
  }

  if (name === "skill_reindex") {
    const counts = await buildIndex();
    return textResult(counts);
  }

  throw new Error(`Unknown tool: ${name}`);
});

await buildIndex();
const transport = new StdioServerTransport();
await server.connect(transport);
