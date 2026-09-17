/**
 * Session Usage — /usage for the current PI-Desktop session.
 *
 * Reads only local usage metadata (transcript jsonl + completed turns).
 * Message text, tool arguments and credentials are never returned.
 */

const { existsSync, readFileSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function emptyTokens() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    total: 0,
  };
}

function addTokens(into, part) {
  if (!part) return into;
  into.input += n(part.input);
  into.output += n(part.output);
  into.cacheRead += n(part.cacheRead);
  into.cacheWrite += n(part.cacheWrite);
  into.cacheWrite5m += n(part.cacheWrite5m);
  into.cacheWrite1h += n(part.cacheWrite1h);
  into.reasoning += n(part.reasoning);
  into.total += n(part.total) || (n(part.input) + n(part.output) + n(part.cacheRead) + n(part.cacheWrite) + n(part.reasoning));
  return into;
}

function cacheCreationParts(usage) {
  const nested =
    usage.cache_creation && typeof usage.cache_creation === "object"
      ? usage.cache_creation
      : usage.cacheCreation && typeof usage.cacheCreation === "object"
        ? usage.cacheCreation
        : {};
  const cacheWrite5m = n(nested.ephemeral_5m_input_tokens ?? nested.ephemeral5mInputTokens);
  const cacheWrite1h = n(nested.ephemeral_1h_input_tokens ?? nested.ephemeral1hInputTokens);
  let cacheWrite = n(
    usage.cacheWriteTokens ??
      usage.cache_creation_input_tokens ??
      usage.cache_write_input_tokens ??
      usage.cacheWrite,
  );
  if (!cacheWrite && (cacheWrite5m || cacheWrite1h)) cacheWrite = cacheWrite5m + cacheWrite1h;
  return { cacheWrite, cacheWrite5m, cacheWrite1h };
}

function toTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = n(usage.inputTokens ?? usage.input_tokens ?? usage.input);
  const output = n(usage.outputTokens ?? usage.output_tokens ?? usage.output);
  const cacheRead = n(
    usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cacheRead ?? usage.cached_tokens,
  );
  const created = cacheCreationParts(usage);
  const reasoning = n(usage.reasoningTokens ?? usage.reasoning_output_tokens ?? usage.reasoning);
  const total = n(usage.totalTokens ?? usage.total_tokens ?? usage.total);
  if (!input && !output && !cacheRead && !created.cacheWrite && !reasoning && !total) return null;
  return {
    input,
    output,
    cacheRead,
    cacheWrite: created.cacheWrite,
    cacheWrite5m: created.cacheWrite5m,
    cacheWrite1h: created.cacheWrite1h,
    reasoning,
    total: total || input + output + cacheRead + created.cacheWrite + reasoning,
  };
}

function promptTokens(tokens) {
  return n(tokens?.input) + n(tokens?.cacheRead) + n(tokens?.cacheWrite);
}

function hitRate(tokens) {
  const prompt = promptTokens(tokens);
  if (!prompt) return null;
  return n(tokens.cacheRead) / prompt;
}

function hostRootFromDataPath(dataPath) {
  return path.resolve(String(dataPath || ""), "..", "..", "..");
}

function openHostDb(dbFile) {
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    return null;
  }
  if (!sqlite?.DatabaseSync) return null;
  try {
    return new sqlite.DatabaseSync(dbFile, { readOnly: true });
  } catch {
    return null;
  }
}

function closeQuietly(db) {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
}

function localeFromRaw(raw) {
  const text = String(raw || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
  if (!text) return "";
  if (text === "zh" || text.startsWith("zh-") || text.includes("hans") || text.includes("chinese")) {
    return "zh-CN";
  }
  return "en";
}

function localeOf(appearance, fallback) {
  return localeFromRaw(appearance?.language || appearance?.locale || fallback) || "zh-CN";
}

function isZh(locale) {
  return locale === "zh-CN";
}

function formatInt(value, locale) {
  return n(value).toLocaleString(isZh(locale) ? "zh-CN" : "en-US");
}

function formatCompact(value) {
  const num = n(value);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num >= 10_000_000 ? 1 : 2).replace(/\.0+$/, "")}M`;
  if (num >= 10_000) return `${(num / 1_000).toFixed(num >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(num));
}

function formatPct(rate, locale) {
  if (rate == null || !Number.isFinite(rate)) return isZh(locale) ? "—" : "n/a";
  return `${(rate * 100).toFixed(1)}%`;
}

function shortId(id) {
  const text = String(id || "");
  return text.length <= 8 ? text : text.slice(0, 8);
}

function parseJsonlUsage(file) {
  const replies = [];
  let malformed = 0;
  let compactCount = 0;
  if (!existsSync(file)) return { replies, malformed, compactCount, missing: true };
  const lines = readFileSync(file, "utf8").split(/\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (record?.type === "compaction" || record?.role === "compactionSummary") {
      compactCount += 1;
      continue;
    }
    if (record?.type !== "message" || record?.role !== "assistant") continue;
    const tokens = toTokens(record.meta?.usage);
    if (!tokens) continue;
    replies.push({
      id: String(record.id || ""),
      createdAt: record.createdAt || null,
      modelId: String(record.meta?.modelId || "unknown"),
      providerId: String(record.meta?.providerId || ""),
      durationMs: n(record.meta?.responseDurationMs),
      tokens,
    });
  }
  return { replies, malformed, compactCount, missing: false };
}

function sumReplies(replies) {
  const totals = emptyTokens();
  const byModel = new Map();
  for (const reply of replies) {
    addTokens(totals, reply.tokens);
    const key = reply.modelId || "unknown";
    const row = byModel.get(key) || { modelId: key, replies: 0, tokens: emptyTokens() };
    row.replies += 1;
    addTokens(row.tokens, reply.tokens);
    byModel.set(key, row);
  }
  if (!totals.total) {
    totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite + totals.reasoning;
  }
  return { totals, byModel: [...byModel.values()].sort((a, b) => b.tokens.total - a.tokens.total) };
}

function readSessionRow(db, sessionId) {
  if (!db || !sessionId) return null;
  try {
    const row = db.prepare(
      "select id, title, model_id, provider_id, thinking_level, updated_at, created_at from sessions where id = ? and deleted_at is null",
    ).get(sessionId);
    return row || null;
  } catch {
    return null;
  }
}

function readRunningSessionIds(db) {
  const ids = new Set();
  if (!db) return ids;
  try {
    const rows = db.prepare(
      "select distinct session_id as id from turns where status in ('running', 'queued', 'pending')",
    ).all();
    for (const row of rows || []) {
      if (row?.id) ids.add(String(row.id));
    }
  } catch {
    /* ignore */
  }
  return ids;
}

function readRecentSessionRows(db, limit = 16) {
  if (!db) return [];
  try {
    return db.prepare(
      "select id, title, model_id, thinking_level, updated_at from sessions where deleted_at is null order by updated_at desc limit ?",
    ).all(limit) || [];
  } catch {
    return [];
  }
}

function jsonlSessionIds(sessionsDir) {
  const ranked = [];
  if (!existsSync(sessionsDir)) return ranked;
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith(".jsonl") || name.includes(".revisions.") || name.startsWith("import-")) continue;
    const file = path.join(sessionsDir, name);
    try {
      ranked.push({ id: name.slice(0, -".jsonl".length), mtime: statSync(file).mtimeMs });
    } catch {
      /* ignore */
    }
  }
  ranked.sort((a, b) => b.mtime - a.mtime);
  return ranked;
}

function resolveSessionId(db, sessionsDir, preferredId, { skipRunning = false } = {}) {
  const preferred = String(preferredId || "").trim();
  if (preferred) return preferred;
  const running = skipRunning ? readRunningSessionIds(db) : new Set();
  const rows = readRecentSessionRows(db, 24);
  const idle = rows.find((row) => row?.id && !running.has(String(row.id)));
  if (idle?.id) return String(idle.id);
  if (rows[0]?.id && !skipRunning) return String(rows[0].id);
  const files = jsonlSessionIds(sessionsDir);
  const idleFile = files.find((row) => !running.has(row.id));
  return idleFile?.id || files[0]?.id || (rows[0]?.id ? String(rows[0].id) : "");
}

function readTurnTotals(db, sessionId) {
  const tokens = emptyTokens();
  let completed = 0;
  if (!db || !sessionId) return { tokens, completed };
  try {
    const rows = db.prepare(
      "select input_tokens, output_tokens, usage_json, status from turns where session_id = ?",
    ).all(sessionId);
    for (const row of rows) {
      const parsed = row.usage_json
        ? toTokens(typeof row.usage_json === "string" ? JSON.parse(row.usage_json) : row.usage_json)
        : null;
      if (parsed) addTokens(tokens, parsed);
      else addTokens(tokens, { input: n(row.input_tokens), output: n(row.output_tokens), cacheRead: 0, cacheWrite: 0, reasoning: 0, total: n(row.input_tokens) + n(row.output_tokens) });
      if (row.status === "completed") completed += 1;
    }
  } catch {
    /* ignore */
  }
  if (!tokens.total) tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
  return { tokens, completed };
}

function metricsOf(tokens) {
  const prompt = promptTokens(tokens);
  return {
    ...tokens,
    prompt,
    hitRate: hitRate(tokens),
    uncachedRate: prompt ? n(tokens.input) / prompt : null,
  };
}

async function appearance() {
  try {
    if (typeof pi.app?.getAppearance === "function") return await pi.app.getAppearance();
  } catch {
    /* ignore */
  }
  return null;
}

async function hostLocale(look) {
  const candidates = [];
  try {
    if (typeof pi.app?.getLocale === "function") {
      candidates.push(await pi.app.getLocale());
    }
  } catch {
    /* ignore */
  }
  try {
    const appearanceLook = look || (await appearance());
    candidates.push(appearanceLook?.locale, appearanceLook?.language);
  } catch {
    /* ignore */
  }
  const mapped = candidates.map(localeFromRaw).filter(Boolean);
  if (mapped.includes("zh-CN")) return "zh-CN";
  return mapped[0] || "zh-CN";
}

async function buildReport(preferredId, options = {}) {
  const dataPath = await pi.plugin.getDataPath();
  const hostRoot = hostRootFromDataPath(dataPath);
  const sessionsDir = path.join(hostRoot, "sessions");
  const dbFile = path.join(hostRoot, "pi.sqlite");
  const db = existsSync(dbFile) ? openHostDb(dbFile) : null;
  try {
    const requested = String(preferredId || "").trim() || focusedSessionId;
    const sessionId = resolveSessionId(db, sessionsDir, requested, {
      skipRunning: !requested && options.skipRunning === true,
    });
    if (sessionId) focusedSessionId = sessionId;
    const look = await appearance();
    const locale = await hostLocale(look);
    const running = readRunningSessionIds(db);
    const untitled = isZh(locale) ? "未命名会话" : "Untitled session";
    const recentSessions = readRecentSessionRows(db, 16).map((row) => ({
      id: String(row.id),
      shortId: shortId(row.id),
      title: row.title || untitled,
      modelId: String(row.model_id || ""),
      running: running.has(String(row.id)),
    }));
    if (!sessionId) {
      return {
        ok: false,
        locale,
        recentSessions,
        error: isZh(locale) ? "没有找到会话。" : "No session found.",
      };
    }
    const file = path.join(sessionsDir, `${sessionId}.jsonl`);
    const parsed = parseJsonlUsage(file);
    const summed = sumReplies(parsed.replies);
    const session = readSessionRow(db, sessionId);
    const turns = readTurnTotals(db, sessionId);
    const last = parsed.replies.length ? parsed.replies[parsed.replies.length - 1] : null;
    if (!recentSessions.some((row) => row.id === sessionId)) {
      recentSessions.unshift({
        id: sessionId,
        shortId: shortId(sessionId),
        title: session?.title || untitled,
        modelId: String(session?.model_id || last?.modelId || ""),
        running: running.has(sessionId),
      });
    }
    return {
      ok: true,
      locale,
      generatedAt: new Date().toISOString(),
      session: {
        id: sessionId,
        shortId: shortId(sessionId),
        title: session?.title || untitled,
        modelId: session?.model_id || last?.modelId || "",
        thinkingLevel: String(session?.thinking_level || "").trim(),
        updatedAt: session?.updated_at || null,
        running: running.has(sessionId),
      },
      replies: parsed.replies.length,
      compactCount: parsed.compactCount,
      malformed: parsed.malformed,
      missingTranscript: parsed.missing,
      totals: metricsOf(summed.totals),
      last: last
        ? {
            modelId: last.modelId,
            createdAt: last.createdAt,
            durationMs: last.durationMs,
            tokens: metricsOf(last.tokens),
          }
        : null,
      byModel: summed.byModel.map((row) => ({
        modelId: row.modelId,
        replies: row.replies,
        tokens: metricsOf(row.tokens),
      })),
      recentSessions,
      turns: {
        completed: turns.completed,
        tokens: metricsOf(turns.tokens),
      },
    };
  } finally {
    closeQuietly(db);
  }
}

function lineFor(tokens, locale) {
  const hit = formatPct(tokens.hitRate, locale);
  const created = n(tokens.cacheWrite);
  if (isZh(locale)) {
    const extra = created ? ` · 缓存创建 ${formatCompact(created)}` : "";
    return `输入 ${formatCompact(tokens.input)} · 缓存命中 ${formatCompact(tokens.cacheRead)}（${hit}）${extra} · 输出 ${formatCompact(tokens.output)}`;
  }
  const extra = created ? ` · create ${formatCompact(created)}` : "";
  return `in ${formatCompact(tokens.input)} · cache ${formatCompact(tokens.cacheRead)} (${hit})${extra} · out ${formatCompact(tokens.output)}`;
}

function toastFor(report) {
  if (!report.ok) return report.error;
  const head = isZh(report.locale) ? "当前会话" : "This session";
  return `${head} · ${lineFor(report.totals, report.locale)}`;
}

function markdownFor(report) {
  if (!report.ok) return report.error;
  const zh = isZh(report.locale);
  const t = report.totals;
  const lines = [];
  lines.push(zh ? `## 会话用量` : `## Session usage`);
  lines.push("");
  lines.push(zh ? `- 会话：${report.session.title} (\`${report.session.shortId}\`)` : `- Session: ${report.session.title} (\`${report.session.shortId}\`)`);
  if (report.session.modelId) {
    lines.push(zh ? `- 模型：${report.session.modelId}` : `- Model: ${report.session.modelId}`);
  }
  lines.push(zh ? `- 助手回复：${report.replies}次` : `- Assistant replies: ${report.replies}`);
  if (report.compactCount) {
    lines.push(zh ? `- 压缩次数：${report.compactCount}` : `- Compactions: ${report.compactCount}`);
  }
  lines.push("");
  lines.push(zh ? `| 类型 | Token |` : `| Kind | Tokens |`);
  lines.push(`| --- | ---: |`);
  lines.push(`${zh ? "输入（未命中）" : "Input (uncached)"} | ${formatInt(t.input, report.locale)} |`);
  lines.push(`${zh ? "缓存命中" : "Cache read"} | ${formatInt(t.cacheRead, report.locale)} |`);
  lines.push(`${zh ? "缓存创建" : "Cache create"} | ${formatInt(t.cacheWrite, report.locale)} |`);
  if (n(t.cacheWrite5m) || n(t.cacheWrite1h)) {
    lines.push(`${zh ? "缓存创建 5m" : "Cache create 5m"} | ${formatInt(t.cacheWrite5m, report.locale)} |`);
    lines.push(`${zh ? "缓存创建 1h" : "Cache create 1h"} | ${formatInt(t.cacheWrite1h, report.locale)} |`);
  }
  lines.push(`${zh ? "提示词合计" : "Prompt total"} | ${formatInt(t.prompt, report.locale)} |`);
  lines.push(`${zh ? "输出" : "Output"} | ${formatInt(t.output, report.locale)} |`);
  lines.push(`${zh ? "思考" : "Reasoning"} | ${formatInt(t.reasoning, report.locale)} |`);
  lines.push(`${zh ? "命中率" : "Hit rate"} | ${formatPct(t.hitRate, report.locale)} |`);
  if (report.last) {
    lines.push("");
    lines.push(zh ? `最近一轮：${lineFor(report.last.tokens, report.locale)}` : `Last reply: ${lineFor(report.last.tokens, report.locale)}`);
  }
  if (report.byModel.length > 1) {
    lines.push("");
    lines.push(zh ? `按模型：` : `By model:`);
    for (const row of report.byModel) {
      lines.push(`- ${row.modelId} · ${row.replies}${zh ? "次" : " turns"} · ${lineFor(row.tokens, report.locale)}`);
    }
  }
  lines.push("");
  lines.push(
    zh
      ? "命中率 = 缓存命中 /（未命中输入 + 缓存命中 + 缓存创建）。Claude 的 cache_creation 会计入缓存创建。"
      : "Hit rate = cache read / (uncached input + cache read + cache create). Claude cache_creation counts as create.",
  );
  return lines.join("\n");
}

async function publish(report) {
  await pi.plugin.setSettings({ lastReport: report });
  return report;
}

async function showUsage() {
  focusedSessionId = "";
  const report = await publish(await buildReport("", { skipRunning: true }));
  await pi.ui.openPanel();
  try {
    await pi.ui.showToast(toastFor(report));
  } catch {
    /* toast is optional */
  }
  return report;
}

let focusedSessionId = "";
let refreshTimer = null;

async function onLoad() {
  await pi.commands.register({
    id: "usage",
    title: "Usage: current session",
    keywords: ["usage", "token", "cache", "用量", "缓存"],
    category: "Session",
    run: async () => {
      await showUsage();
    },
  });
  try {
    await publish(await buildReport("", { skipRunning: true }));
  } catch {
    /* first scan is best-effort */
  }
  refreshTimer = setInterval(() => {
    publish(buildReport(focusedSessionId)).catch(() => {});
  }, 8000);
}

async function onPanelInvoke(channel, payload) {
  if (channel === "usage.refresh") {
    const sessionId = String(payload?.sessionId || "").trim();
    if (sessionId) focusedSessionId = sessionId;
    return publish(await buildReport(focusedSessionId));
  }
  if (channel === "usage.get") {
    const settings = await pi.plugin.getSettings();
    if (settings?.lastReport) return settings.lastReport;
    return publish(await buildReport(focusedSessionId));
  }
  return { ok: false, error: `unknown channel: ${channel}` };
}

async function onUnload() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  focusedSessionId = "";
  try {
    await pi.commands.unregister("usage");
  } catch {
    /* ignore */
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
