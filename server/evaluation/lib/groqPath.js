// The working parts of the Groq path measurement (evaluation/groqPath.mjs,
// docs/measurements/groq-path.md): a recorder around fetch, and the tables built
// from what it and the app's log lines saved. The recorder keeps each request's
// status, times, tokens and rate-limit headers, and never the key or the request
// body. Nothing here calls Groq or reads a file, so all of it can be tested with
// made-up data.
import { parseJsonLoose } from "../../src/services/llm.js";

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

const LIMIT_HEADERS = {
  limit_requests: "x-ratelimit-limit-requests",
  remaining_requests: "x-ratelimit-remaining-requests",
  reset_requests: "x-ratelimit-reset-requests",
  limit_tokens: "x-ratelimit-limit-tokens",
  remaining_tokens: "x-ratelimit-remaining-tokens",
  reset_tokens: "x-ratelimit-reset-tokens",
};

/** "1m26.4s", "7.66s", "120ms" or "1h2m3s" in milliseconds, or null if it is none of those. */
export function durationMs(text) {
  const s = String(text ?? "").trim();
  if (!/^(?:\d+(?:\.\d+)?(?:h|ms|m|s))+$/.test(s)) return null;
  const unit = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  let total = 0;
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) total += Number(n) * unit[u];
  return total;
}

// The opening words of each prompt in testEngine.js, to tell the three requests of
// a build apart. Only the kind is kept: the prompt and the notes are not.
const KINDS = [
  ["mcq", /^You are setting multiple-choice/],
  ["theory", /^You are setting the theory/],
  ["verify", /^You are an independent examiner/],
];

/** What may be kept about a request: its kind, its model and its size. Never its text. */
export function describeRequest(body) {
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* not JSON: an unknown kind of request */
  }
  const system = Array.isArray(parsed?.messages) ? parsed.messages.find((m) => m?.role === "system")?.content : null;
  const kind = KINDS.find(([, re]) => re.test(String(system ?? "")))?.[0] || "other";
  return { kind, model: typeof parsed?.model === "string" ? parsed.model : null, body_chars: String(body ?? "").length };
}

/**
 * Which limit a refusal names, from the numbers in its message only. The message
 * itself is not kept: it names the organisation, and an error can echo the request.
 */
export function readRefusal(message) {
  const text = String(message ?? "");
  const m = text.match(/\((TPM|TPD|RPM|RPD|ASH|ASD)\):\s*Limit\s+(\d+)(?:,\s*Used\s+(\d+))?(?:,\s*Requested\s+(\d+))?/i);
  const wait = text.match(/try again in\s+([0-9hms.]*[hms])/i);
  return {
    limit_name: m ? m[1].toUpperCase() : null,
    limit: m ? Number(m[2]) : null,
    used: m?.[3] ? Number(m[3]) : null,
    requested: m?.[4] ? Number(m[4]) : null,
    try_again_ms: wait ? durationMs(wait[1]) : null,
  };
}

const DAILY_LIMITS = new Set(["TPD", "RPD", "ASD"]);

/** What became of a request, in this measurement's own words (the app's are in its log lines). */
export function outcomeOf(status, refusal = null) {
  if (status === 200) return "ok";
  if (status === 429 || status === 413) {
    if (DAILY_LIMITS.has(refusal?.limit_name)) return "refused-day";
    if (refusal?.limit_name) return "refused-minute";
    return status === 413 ? "too-large" : "refused-unknown";
  }
  if (status === 404) return "not-found";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server-error";
  return "bad-status";
}

export const isRefusal = (r) => /^refused-|^too-large$/.test(r.outcome);
export const isDailyStop = (r) => r.outcome === "refused-day" || r.outcome === "auth";

/** How the app's parser reads a reply: an array is all the question writers and the check can use. */
export function readingOf(content, parse = parseJsonLoose) {
  const parsed = parse(content);
  if (Array.isArray(parsed)) return { reads: "array", items: parsed.length };
  return { reads: parsed ? "other-json" : "unreadable", items: 0 };
}

const isTimeout = (err) => err?.name === "TimeoutError" || err?.name === "AbortError";

/**
 * fetch with a record of every request to the AI. The response goes back to the
 * app untouched, as soon as it arrives, and a copy is read on the side, so the
 * app's own time-out and reading behave as they would without the recorder.
 *   isLlm     says which URLs are the AI's (anything else passes straight through)
 *   add       is given one row per request
 *   addReply  is given each reply's text; only the git-ignored folder may hold it
 * Set recorder.build to tag the rows, and await recorder.settle() before reading them.
 */
export function recordingFetch(realFetch, { isLlm, add, addReply = () => {} }) {
  const reading = new Set();
  let seq = 0;
  const recorder = async (url, init = {}) => {
    if (!isLlm(String(url?.url ?? url))) return realFetch(url, init);
    const row = { build: recorder.build, seq: ++seq, ...describeRequest(init.body), started_at_ms: Date.now() };
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    let res;
    try {
      res = await realFetch(url, init);
    } catch (err) {
      add({ ...row, status: null, ms: elapsed(), outcome: isTimeout(err) ? "timeout" : "network" });
      throw err;
    }
    row.status = res.status;
    row.headers_ms = elapsed();
    row.retry_after = res.headers.get("retry-after");
    row.limits = Object.fromEntries(Object.entries(LIMIT_HEADERS).map(([k, h]) => [k, res.headers.get(h)]));
    const done = res
      .clone()
      .text()
      .then((text) => fillFromBody(row, text, addReply))
      .catch((err) => {
        row.outcome = isTimeout(err) ? "timeout-in-body" : "network-in-body";
      })
      .then(() => {
        row.ms = elapsed();
        add(row);
        reading.delete(done);
      });
    reading.add(done);
    return res;
  };
  recorder.build = null;
  recorder.settle = async () => {
    while (reading.size) await Promise.all(reading);
  };
  return recorder;
}

function fillFromBody(row, text, addReply) {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* an answer that is not JSON: the app gets nothing from it either */
  }
  if (row.status !== 200) {
    row.refusal = readRefusal(data?.error?.message);
    row.error_code = data?.error?.code || data?.error?.type ? String(data.error.code || data.error.type).slice(0, 60) : null;
    row.outcome = outcomeOf(row.status, row.refusal);
    return;
  }
  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? null;
  const usage = data?.usage || null;
  row.finish_reason = choice?.finish_reason ?? null;
  row.tokens = usage
    ? { prompt: usage.prompt_tokens ?? null, completion: usage.completion_tokens ?? null, total: usage.total_tokens ?? null, reasoning: usage.completion_tokens_details?.reasoning_tokens ?? null, cached: usage.prompt_tokens_details?.cached_tokens ?? null }
    : null;
  row.groq_seconds = usage ? { queue: usage.queue_time ?? null, prompt: usage.prompt_time ?? null, completion: usage.completion_time ?? null } : null;
  row.content_chars = String(content ?? "").length;
  row.reasoning_chars = String(choice?.message?.reasoning ?? "").length;
  row.think_tags_in_content = /<think>/i.test(String(content ?? ""));
  row.outcome = content ? "ok" : "empty";
  if (!content) return;
  Object.assign(row, readingOf(content));
  addReply({ build: row.build, seq: row.seq, kind: row.kind, model: row.model, finish_reason: row.finish_reason, content });
}

/** How long to leave before the next build so the minute limit has recovered: the gap, or what the provider last said if that is longer. */
export function spacedWaitMs(requests, gapSeconds, most = 180_000) {
  let wait = gapSeconds * 1000;
  for (const r of requests) {
    const reset = durationMs(r.limits?.reset_tokens);
    if (reset !== null) wait = Math.max(wait, reset + 1000);
    if (r.refusal?.try_again_ms) wait = Math.max(wait, r.refusal.try_again_ms + 1000);
  }
  return Math.min(most, wait);
}

// ---------------------------------------------------------------------------
// The app's log lines
// ---------------------------------------------------------------------------

export const LOG_LINE = /^\[(?:testgen|quality|concepts|llm|semantic)\]/;

function fieldsOf(text) {
  const out = {};
  for (const [, k, v] of String(text).matchAll(/(\w+)=(\S*)/g)) out[k] = /^-?\d+$/.test(v) ? Number(v) : v;
  return out;
}

/** The [testgen] and [quality] lines of one build, as fields. */
export function readLogLines(lines) {
  const out = { testgen: {}, quality: {}, llm_failures: 0 };
  for (const line of lines) {
    const t = line.match(/^\[testgen\] (mcq|theory): (.*)$/);
    const q = line.match(/^\[quality\] (mcq|theory): (.*)$/);
    if (t) out.testgen[t[1]] = fieldsOf(t[2]);
    else if (q) {
      const [before, reasons] = q[2].split(" reasons=");
      out.quality[q[1]] = { ...fieldsOf(before), reasons: Object.fromEntries((reasons || "").split(" ").filter(Boolean).map((p) => [p.slice(0, p.lastIndexOf(":")), Number(p.slice(p.lastIndexOf(":") + 1))])) };
    } else if (/^\[llm\] request (?:failed|errored)/.test(line)) out.llm_failures++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// One build
// ---------------------------------------------------------------------------

const blankFunnel = () => ({ stopped_by_gate: 0, rejected_by_evaluator: 0, duplicates: 0, chosen: 0, chosen_revised: 0, reasons: {} });
const writerOf = (q) => (q.generatedBy === "llm" ? "llm" : "rules");

/**
 * What became of each draft, per question type and writer, from what
 * generateQuestions returned. A question that passed but was not needed is in
 * neither list; for the AI's drafts that share is worked out from llmDrafts.
 */
export function funnelOf(result) {
  const out = { mcq: { llm: blankFunnel(), rules: blankFunnel() }, theory: { llm: blankFunnel(), rules: blankFunnel() } };
  for (const q of result.accepted) {
    const f = out[q.type][writerOf(q)];
    f.chosen++;
    if (q.quality?.decision === "revise") f.chosen_revised++;
  }
  for (const q of result.discarded) {
    const f = out[q.type][writerOf(q)];
    if (q.quality?.decision === "reject") f.rejected_by_evaluator++;
    else if (/^duplicate/.test(String(q.discardReason))) f.duplicates++;
    else f.stopped_by_gate++;
    for (const r of String(q.discardReason || "unknown").split(",")) f.reasons[r] = (f.reasons[r] || 0) + 1;
  }
  return out;
}

const GENERATION_FIELDS = ["status", "llmAttempted", "llmOutcome", "fallbackReason", "byLlm", "byRules", "llmDrafts", "llmRejected", "llmMs"];
const pickFields = (g) => (g ? Object.fromEntries(GENERATION_FIELDS.map((k) => [k, g[k] ?? null])) : null);

/** One build as a row of counts. No question text. */
export function buildRow({ key, doc, mode, pacing, rep, model, startedAt, wallMs, result, lines, asked }) {
  const log = readLogLines(lines);
  const logged = Object.values(log.testgen).map((t) => t.totalMs).filter((x) => typeof x === "number");
  const generation = { mcq: pickFields(result.generation?.mcq), theory: pickFields(result.generation?.theory) };
  return {
    key,
    doc,
    mode,
    pacing,
    rep,
    model,
    started_at: startedAt,
    wall_ms: wallMs,
    total_ms: logged.length ? Math.max(...logged) : null,
    asked,
    produced: result.accepted.length,
    by_llm: result.accepted.filter((q) => q.generatedBy === "llm").length,
    by_rules: result.accepted.filter((q) => q.generatedBy !== "llm").length,
    generation,
    log,
    funnel: funnelOf(result),
  };
}

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

export function median(xs) {
  const v = [...xs].sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const statOf = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return v.length ? { n: v.length, median: median(v), slowest: Math.max(...v) } : null;
};
const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);

/** Time with at least one request in the air: overlapping requests count once, and waits between them not at all. */
export function inFlightMs(requests) {
  const spans = requests.filter((r) => typeof r.ms === "number").map((r) => [r.started_at_ms, r.started_at_ms + r.ms]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of spans) {
    if (a > end) {
      total += b - a;
      end = b;
    } else if (b > end) {
      total += b - end;
      end = b;
    }
  }
  return total;
}

const addCounts = (into, from) => {
  for (const [k, v] of Object.entries(from || {})) into[k] = (into[k] || 0) + v;
  return into;
};
const topReasons = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([reason, n]) => ({ reason, n }));

function typeSummary(builds, type) {
  const llm = blankFunnel();
  const rules = blankFunnel();
  const statuses = {};
  const fallback = {};
  const quality = { accepted: 0, revised: 0, rejected: 0 };
  let drafts = 0;
  let surplus = 0;
  const present = builds.filter((b) => b.generation[type]);
  for (const b of present) {
    const g = b.generation[type];
    statuses[g.status] = (statuses[g.status] || 0) + 1;
    if (g.fallbackReason) fallback[g.fallbackReason] = (fallback[g.fallbackReason] || 0) + 1;
    drafts += g.llmDrafts || 0;
    const q = b.log.quality[type];
    if (q) for (const k of Object.keys(quality)) quality[k] += q[k] || 0;
    for (const [into, from] of [[llm, b.funnel[type].llm], [rules, b.funnel[type].rules]]) {
      for (const k of ["stopped_by_gate", "rejected_by_evaluator", "duplicates", "chosen", "chosen_revised"]) into[k] += from[k];
      addCounts(into.reasons, from.reasons);
    }
    const f = b.funnel[type].llm;
    surplus += (g.llmDrafts || 0) - f.stopped_by_gate - f.rejected_by_evaluator - f.duplicates - f.chosen;
  }
  const passed = drafts - llm.stopped_by_gate - llm.rejected_by_evaluator;
  return {
    builds: present.length,
    statuses,
    fallback_reasons: topReasons(fallback),
    log_quality: quality,
    ai_drafts: drafts,
    ai_passed_filter: passed,
    ai_pass_share: drafts ? passed / drafts : null,
    ai: { ...llm, reasons: topReasons(llm.reasons) },
    ai_passed_but_not_needed: surplus,
    rules: { ...rules, reasons: topReasons(rules.reasons) },
    ai_time_ms: statOf(present.map((b) => (b.generation[type].llmAttempted ? b.generation[type].llmMs : null))),
  };
}

const writtenBy = (b) => (!b.produced ? "none" : b.by_rules === 0 ? "all_ai" : b.by_llm === 0 ? "all_rules" : "some_ai");

/** The numbers for one way of building (rules only, AI spaced, AI back to back). */
export function conditionSummary(builds, allRequests) {
  const keys = new Set(builds.map((b) => b.key));
  const requests = allRequests.filter((r) => keys.has(r.build));
  const perBuild = builds.map((b) => {
    const mine = requests.filter((r) => r.build === b.key);
    const tokens = mine.map((r) => r.tokens).filter(Boolean);
    return {
      requests: mine.length,
      refused: mine.filter(isRefusal).length,
      in_flight_ms: inFlightMs(mine),
      prompt: sum(tokens.map((t) => t.prompt)),
      completion: sum(tokens.map((t) => t.completion)),
      reasoning: sum(tokens.map((t) => t.reasoning)),
      total: sum(tokens.map((t) => t.total)),
    };
  });
  const verifyStatus = {};
  const verifyFound = { llm: {}, rules: {} };
  for (const b of builds) {
    const q = b.log.quality.mcq;
    const status = q ? q.verify : "no-line";
    verifyStatus[status] = (verifyStatus[status] || 0) + 1;
    for (const w of ["llm", "rules"]) {
      for (const [r, n] of Object.entries(b.funnel.mcq[w].reasons)) if (r.startsWith("verify:")) verifyFound[w][r] = (verifyFound[w][r] || 0) + n;
    }
  }
  const written = { all_ai: 0, some_ai: 0, all_rules: 0, none: 0 };
  for (const b of builds) written[writtenBy(b)]++;
  return {
    builds: builds.length,
    total_ms: statOf(builds.map((b) => b.total_ms ?? b.wall_ms)),
    in_flight_ms: statOf(perBuild.map((p) => p.in_flight_ms)),
    requests_per_build: statOf(perBuild.map((p) => p.requests)),
    requests_total: requests.length,
    refused_total: sum(perBuild.map((p) => p.refused)),
    tokens_per_build: { prompt: statOf(perBuild.map((p) => p.prompt)), completion: statOf(perBuild.map((p) => p.completion)), reasoning: statOf(perBuild.map((p) => p.reasoning)), total: statOf(perBuild.map((p) => p.total)) },
    tokens_total: sum(perBuild.map((p) => p.total)),
    produced: statOf(builds.map((b) => b.produced)),
    produced_total: sum(builds.map((b) => b.produced)),
    asked_total: sum(builds.map((b) => b.asked.mcq + b.asked.theory)),
    by_llm_total: sum(builds.map((b) => b.by_llm)),
    by_rules_total: sum(builds.map((b) => b.by_rules)),
    written,
    types: { mcq: typeSummary(builds, "mcq"), theory: typeSummary(builds, "theory") },
    verify: {
      status: verifyStatus,
      builds_checked: builds.filter((b) => b.log.quality.mcq?.verify === "checked").length,
      questions_checked: sum(builds.map((b) => b.log.quality.mcq?.verified)),
      found: { ai: topReasons(verifyFound.llm), rules: topReasons(verifyFound.rules) },
    },
    replies: {
      read: requests.filter((r) => r.reads === "array").length,
      not_read: requests.filter((r) => r.outcome === "ok" && r.reads !== "array").length,
      empty: requests.filter((r) => r.outcome === "empty").length,
    },
  };
}

const kindRow = (requests) => {
  // an empty reply was still answered, and its tokens were still spent
  const answered = requests.filter((r) => r.status === 200);
  const outcomes = {};
  for (const r of requests) outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
  const finish = {};
  for (const r of answered) finish[String(r.finish_reason)] = (finish[String(r.finish_reason)] || 0) + 1;
  const tokens = answered.map((r) => r.tokens).filter(Boolean);
  return {
    requests: requests.length,
    outcomes,
    ms: statOf(requests.map((r) => r.ms)),
    prompt_tokens: statOf(tokens.map((t) => t.prompt)),
    completion_tokens: statOf(tokens.map((t) => t.completion)),
    reasoning_tokens: statOf(tokens.map((t) => t.reasoning)),
    finish_reasons: finish,
    think_tags_in_content: requests.filter((r) => r.think_tags_in_content).length,
    reasoning_field: requests.filter((r) => r.reasoning_chars > 0).length,
  };
};

/** Each kind of request (MCQ, theory, blind check) on its own. */
export function byKind(requests) {
  return Object.fromEntries(["mcq", "theory", "verify", "other"].filter((k) => requests.some((r) => r.kind === k)).map((k) => [k, kindRow(requests.filter((r) => r.kind === k))]));
}

/**
 * The limits seen for each model. Going by the headers alone, the request window
 * comes from how long the counter says it needs to refill what was used: reset x
 * limit / used.
 */
export function limitsSeen(requests) {
  const out = {};
  for (const model of new Set(requests.map((r) => r.model))) {
    const mine = requests.filter((r) => r.model === model);
    const distinct = (k) => [...new Set(mine.map((r) => r.limits?.[k]).filter((x) => x !== null && x !== undefined))];
    const numbers = (k) => mine.map((r) => r.limits?.[k]).filter((x) => x !== null && x !== undefined).map(Number).filter(Number.isFinite);
    const windows = mine
      .map((r) => {
        const limit = Number(r.limits?.limit_requests);
        const used = limit - Number(r.limits?.remaining_requests);
        const reset = durationMs(r.limits?.reset_requests);
        return used > 0 && reset !== null ? (reset * limit) / used / 3_600_000 : null;
      })
      .filter((x) => x !== null);
    const refusals = {};
    for (const r of mine.filter((x) => x.refusal?.limit_name)) {
      const f = (refusals[r.refusal.limit_name] ||= { count: 0, limit: r.refusal.limit, largest_used: null, largest_requested: null, longest_wait_ms: null });
      f.count++;
      f.largest_used = Math.max(f.largest_used ?? 0, r.refusal.used ?? 0) || null;
      f.largest_requested = Math.max(f.largest_requested ?? 0, r.refusal.requested ?? 0) || null;
      f.longest_wait_ms = Math.max(f.longest_wait_ms ?? 0, r.refusal.try_again_ms ?? 0) || null;
    }
    const retryAfter = mine.map((r) => Number(r.retry_after)).filter((x) => Number.isFinite(x) && x > 0);
    const statuses = {};
    for (const r of mine) statuses[r.status] = (statuses[r.status] || 0) + 1;
    out[model] = {
      requests: mine.length,
      statuses,
      limit_requests: distinct("limit_requests"),
      limit_tokens: distinct("limit_tokens"),
      lowest_remaining_requests: numbers("remaining_requests").length ? Math.min(...numbers("remaining_requests")) : null,
      lowest_remaining_tokens: numbers("remaining_tokens").length ? Math.min(...numbers("remaining_tokens")) : null,
      request_window_hours: windows.length ? median(windows) : null,
      refusals,
      retry_after_seconds: retryAfter.length ? { n: retryAfter.length, longest: Math.max(...retryAfter) } : null,
    };
  }
  return out;
}

/**
 * Every saved reply through the parser as it was before commit d72ac82 and as it
 * is now. A reply counts as read when it gives the array the app needs.
 */
export function replayReplies(replies, oldParse, currentParse = parseJsonLoose) {
  const out = { replies: replies.length, plain_json: 0, read_by_both: 0, same_result: 0, different_result: 0, lost_only_by_old: 0, lost_only_by_current: 0, lost_by_both: 0, old_lost: [], both_lost: [], escapes_in_old_lost: {} };
  for (const r of replies) {
    try {
      if (Array.isArray(JSON.parse(r.content))) out.plain_json++;
    } catch {
      /* needs the parser's repairs, or is not JSON at all */
    }
    const before = oldParse(r.content);
    const now = currentParse(r.content);
    const [a, b] = [Array.isArray(before), Array.isArray(now)];
    const id = { build: r.build, seq: r.seq, kind: r.kind, finish_reason: r.finish_reason ?? null, think_tags: /<think>/i.test(String(r.content)) };
    if (a && b) {
      out.read_by_both++;
      if (JSON.stringify(before) === JSON.stringify(now)) out.same_result++;
      else out.different_result++;
    } else if (b) {
      out.lost_only_by_old++;
      out.old_lost.push(id);
      for (const [e] of String(r.content).matchAll(/\\[^a-zA-Z"\\/]/g)) out.escapes_in_old_lost[e] = (out.escapes_in_old_lost[e] || 0) + 1;
    } else if (a) out.lost_only_by_current++;
    else {
      out.lost_by_both++;
      out.both_lost.push(id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The whole run
// ---------------------------------------------------------------------------

export const CONDITIONS = [
  { id: "rules", label: "Rules only", match: (b) => b.mode === "rules" },
  { id: "spaced", label: "AI, spaced", match: (b) => b.mode === "ai" && b.pacing === "spaced" },
  { id: "back-to-back", label: "AI, back to back", match: (b) => b.mode === "ai" && b.pacing === "back-to-back" },
];

/** The tables, from the saved rows alone. */
export function scoreRun(builds, requests, replay = null) {
  const conditions = {};
  for (const c of CONDITIONS) {
    const inside = builds.filter(c.match);
    if (inside.length) conditions[c.id] = { label: c.label, ...conditionSummary(inside, requests) };
  }
  return {
    conditions,
    by_kind: byKind(requests),
    limits: limitsSeen(requests),
    replay,
    per_build: builds.map((b) => {
      const mine = requests.filter((r) => r.build === b.key);
      return {
        key: b.key,
        doc: b.doc,
        mode: b.mode,
        pacing: b.pacing,
        mcq: b.generation.mcq ? { status: b.generation.mcq.status, reason: b.generation.mcq.fallbackReason, drafts: b.generation.mcq.llmDrafts } : null,
        theory: b.generation.theory ? { status: b.generation.theory.status, reason: b.generation.theory.fallbackReason, drafts: b.generation.theory.llmDrafts } : null,
        verify: b.log.quality.mcq?.verify ?? null,
        verified: b.log.quality.mcq?.verified ?? 0,
        produced: b.produced,
        by_llm: b.by_llm,
        requests: mine.length,
        refused: mine.filter(isRefusal).length,
        tokens: sum(mine.map((r) => r.tokens?.total)),
        total_ms: b.total_ms ?? b.wall_ms,
      };
    }),
  };
}

const secs = (ms) => (ms === null || ms === undefined ? "-" : `${(ms / 1000).toFixed(1)} s`);
const whole = (x) => (x === null || x === undefined ? "-" : Math.round(x).toLocaleString("en-US"));
const pct = (x) => (x === null || x === undefined ? "-" : `${(x * 100).toFixed(1)}%`);
const counts = (o) => Object.entries(o || {}).map(([k, v]) => `${k} ${v}`).join(", ") || "-";
const listed = (rows, most = 8) => rows.slice(0, most).map((r) => `${r.reason} ${r.n}`).join(", ") || "-";
const medSlow = (s, f) => (s ? `${f(s.median)} / ${f(s.slowest)}` : "-");

/** The results as tables for the report. Counts only: no question or note text. */
export function resultsMarkdown(r) {
  const cs = Object.values(r.conditions);
  const row = (label, f) => `| ${label} | ${cs.map(f).join(" | ")} |`;
  const lines = [
    "# Groq path measurement",
    "",
    `Commit ${r.commit || "unknown"}${r.uncommitted_changes ? " (with uncommitted changes)" : ""}, seed ${r.seed}. Model ${r.model}${r.model_from_setting ? " (LLM_MODEL)" : " (the app's default)"}. A build asks for a pool of ${r.mcq} MCQs and ${r.theory} theory questions. Spaced builds are at least ${r.gap_seconds} seconds apart.`,
    ...(r.stopped ? ["", `**Stopped early: ${r.stopped}**`] : []),
    "",
    "## AI against rules only (median / slowest)",
    "",
    `| Measure | ${cs.map((c) => c.label).join(" | ")} |`,
    `| --- | ${cs.map(() => "---").join(" | ")} |`,
    row("Builds", (c) => c.builds),
    row("Total time", (c) => medSlow(c.total_ms, secs)),
    row("Time with a request in the air", (c) => medSlow(c.in_flight_ms, secs)),
    row("`llmMs`, MCQ", (c) => medSlow(c.types.mcq.ai_time_ms, secs)),
    row("`llmMs`, theory", (c) => medSlow(c.types.theory.ai_time_ms, secs)),
    row("Requests per build", (c) => medSlow(c.requests_per_build, whole)),
    row("Requests refused, all builds", (c) => `${c.refused_total} of ${c.requests_total}`),
    row("Tokens per build", (c) => medSlow(c.tokens_per_build.total, whole)),
    row("Of those, the reply", (c) => medSlow(c.tokens_per_build.completion, whole)),
    row("Of those, reasoning", (c) => medSlow(c.tokens_per_build.reasoning, whole)),
    row("Tokens, all builds", (c) => whole(c.tokens_total)),
    row("Questions produced / asked", (c) => `${c.produced_total} / ${c.asked_total}`),
    row("Written by the AI / by the rules", (c) => `${c.by_llm_total} / ${c.by_rules_total}`),
    row("Builds: all AI, some AI, all rules, none", (c) => `${c.written.all_ai}, ${c.written.some_ai}, ${c.written.all_rules}, ${c.written.none}`),
    row("Blind AI check: builds it ran on", (c) => `${c.verify.builds_checked}`),
    row("Blind AI check: questions checked", (c) => c.verify.questions_checked),
    row("Blind AI check: status", (c) => counts(c.verify.status)),
    row("Replies: read / not read / empty", (c) => `${c.replies.read} / ${c.replies.not_read} / ${c.replies.empty}`),
    "",
    "## The filter, per question type",
    "",
    "| Condition | Type | Status of the build | Fallback reasons | AI drafts | AI passed the filter | Stopped by the gate | Rejected by the evaluator | Repeats | Chosen | Passed, not needed | Log: accepted, revised, rejected |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const c of cs) {
    for (const t of ["mcq", "theory"]) {
      const s = c.types[t];
      lines.push(`| ${c.label} | ${t} | ${counts(s.statuses)} | ${listed(s.fallback_reasons)} | ${s.ai_drafts} | ${s.ai_passed_filter} (${pct(s.ai_pass_share)}) | ${s.ai.stopped_by_gate} | ${s.ai.rejected_by_evaluator} | ${s.ai.duplicates} | ${s.ai.chosen} | ${s.ai_passed_but_not_needed} | ${s.log_quality.accepted}, ${s.log_quality.revised}, ${s.log_quality.rejected} |`);
    }
  }
  lines.push("", "## Commonest reasons", "", "| Condition | Type | Writer | Reasons |", "| --- | --- | --- | --- |");
  for (const c of cs) {
    for (const t of ["mcq", "theory"]) {
      if (c.types[t].ai.reasons.length) lines.push(`| ${c.label} | ${t} | AI | ${listed(c.types[t].ai.reasons)} |`);
      if (c.types[t].rules.reasons.length) lines.push(`| ${c.label} | ${t} | Rules | ${listed(c.types[t].rules.reasons)} |`);
    }
  }
  lines.push("", "## What the blind AI check found", "", "| Condition | AI's questions | Rules' questions |", "| --- | --- | --- |");
  for (const c of cs) lines.push(`| ${c.label} | ${listed(c.verify.found.ai)} | ${listed(c.verify.found.rules)} |`);
  lines.push("", "## Each kind of request", "", "| Kind | Requests | Outcomes | Time (median / slowest) | Prompt tokens | Reply tokens | Reasoning tokens | Finish | Reasoning field | `<think>` in the reply |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [k, v] of Object.entries(r.by_kind)) {
    lines.push(`| ${k} | ${v.requests} | ${counts(v.outcomes)} | ${medSlow(v.ms, secs)} | ${medSlow(v.prompt_tokens, whole)} | ${medSlow(v.completion_tokens, whole)} | ${medSlow(v.reasoning_tokens, whole)} | ${counts(v.finish_reasons)} | ${v.reasoning_field} | ${v.think_tags_in_content} |`);
  }
  lines.push("", "## Limits seen", "");
  for (const [model, l] of Object.entries(r.limits)) {
    lines.push(`- **${model}**: ${l.requests} requests (${counts(l.statuses)}). Headers: limit ${l.limit_requests.join(", ") || "-"} requests, ${l.limit_tokens.join(", ") || "-"} tokens. Lowest remaining: ${whole(l.lowest_remaining_requests)} requests, ${whole(l.lowest_remaining_tokens)} tokens. Request window worked out from the headers: ${l.request_window_hours === null ? "-" : `${l.request_window_hours.toFixed(1)} hours`}. Longest retry-after: ${l.retry_after_seconds ? `${l.retry_after_seconds.longest} s` : "-"}.`);
    for (const [name, f] of Object.entries(l.refusals)) lines.push(`  - Refused on ${name} ${f.count} times: limit ${whole(f.limit)}, most used ${whole(f.largest_used)}, most requested ${whole(f.largest_requested)}, longest wait asked for ${secs(f.longest_wait_ms)}.`);
  }
  lines.push("", "## Replies lost to bad JSON", "");
  if (!r.replay) lines.push("Not run: no saved replies.");
  else if (r.replay.reason) lines.push(`Not run: ${r.replay.reason}.`);
  else {
    lines.push(
      `${r.replay.replies} saved replies. ${r.replay.plain_json} are plain JSON that need no repair. Read by the old and the current parser: ${r.replay.read_by_both} (${r.replay.same_result} the same, ${r.replay.different_result} different). Lost only by the old parser (the bug): **${r.replay.lost_only_by_old}**${Object.keys(r.replay.escapes_in_old_lost).length ? ` (backslashes in them: ${counts(r.replay.escapes_in_old_lost)})` : ""}. Lost only by the current parser: ${r.replay.lost_only_by_current}. Lost by both: ${r.replay.lost_by_both}.`
    );
  }
  lines.push("", "## Each build", "", "| Build | MCQ | Theory | Check | Produced | By AI | Requests | Refused | Tokens | Total time |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const part = (p) => (p ? `${p.status}${p.reason ? ` (${p.reason})` : ""}` : "-");
  for (const b of r.per_build) lines.push(`| ${b.mode === "rules" ? "rules" : b.pacing}: ${b.doc} | ${part(b.mcq)} | ${part(b.theory)} | ${b.verify ?? "-"}${b.verified ? ` (${b.verified})` : ""} | ${b.produced} | ${b.by_llm} | ${b.requests} | ${b.refused} | ${whole(b.tokens)} | ${secs(b.total_ms)} |`);
  lines.push("");
  return lines.join("\n");
}
