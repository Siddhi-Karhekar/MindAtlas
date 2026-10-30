// How long each API request takes, and how much of that is the database.
//
// The live API (Render, Singapore) and its database (Atlas, Mumbai) are in
// different regions, so every query is a round trip between them, and the
// free instance has a tenth of a CPU. Which of the two makes a page slow
// decides the fix, so every request is measured:
//
//   - the answer to a signed-in request carries a Server-Timing header,
//     shown in the browser's developer tools (Network -> the request ->
//     Timing): `db` is the time at least one query was waiting, with the
//     number of queries, and `total` the whole request. Only signed-in
//     requests get it: on sign-in, sign-up or a reset email the number of
//     queries would say whether an account exists;
//   - a request slower than SLOW_REQUEST_MS (default 1000) is logged with its
//     route pattern, never its ids or query string:
//       [slow] GET /api/subjects/:id/graph 200 1834 ms (db 1210 ms, 7 queries)
//
// Database time is collected without passing anything through the routes:
// the request's record lives in an AsyncLocalStorage, and db/index.js hands
// out collections whose methods add their time to it (timedCollection).

import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { envNumber } from "../config.js";

const current = new AsyncLocalStorage();

function newRecord() {
  return { start: performance.now(), queries: 0, inFlight: 0, busySince: 0, dbMs: 0 };
}

// Wall-clock time with at least one query running: three queries run side
// by side for 60 ms count as 60 ms, not 180, so `db` compares with `total`.
function queryStarted(rec) {
  rec.queries++;
  if (rec.inFlight++ === 0) rec.busySince = performance.now();
}
function queryEnded(rec) {
  if (--rec.inFlight === 0) rec.dbMs += performance.now() - rec.busySince;
}
const dbMsOf = (rec) => rec.dbMs + (rec.inFlight > 0 ? performance.now() - rec.busySince : 0);

/** A collection whose every method call is counted against the request it was made for. */
export function timedCollection(col) {
  return new Proxy(col, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return function timed(...args) {
        const rec = current.getStore();
        if (!rec) return value.apply(target, args);
        queryStarted(rec);
        let result;
        try {
          result = value.apply(target, args);
        } catch (err) {
          queryEnded(rec);
          throw err;
        }
        return Promise.resolve(result).finally(() => queryEnded(rec));
      };
    },
  });
}

// "/api/subjects/:id/graph", from the route that answered; for an answer
// given before routing (a rate limit, a 404) the path with its ids masked.
function routeOf(req) {
  if (req.route?.path) return `${req.baseUrl || ""}${req.route.path}`.replace(/(.)\/$/, "$1");
  return String(req.originalUrl || req.url || "").split("?")[0].replace(/[0-9a-f]{24}/gi, ":id");
}

const round = (ms) => Math.round(ms * 10) / 10;

export function requestTiming(req, res, next) {
  const rec = newRecord();

  const writeHead = res.writeHead;
  res.writeHead = function writeHeadWithTiming(...args) {
    if (req.user && !res.headersSent) {
      const total = performance.now() - rec.start;
      res.setHeader("Server-Timing", `db;dur=${round(dbMsOf(rec))};desc="${rec.queries} queries", total;dur=${round(total)}`);
    }
    return writeHead.apply(this, args);
  };

  res.on("finish", () => {
    const total = performance.now() - rec.start;
    if (total < envNumber("SLOW_REQUEST_MS", 1000)) return;
    console.warn(`[slow] ${req.method} ${routeOf(req)} ${res.statusCode} ${Math.round(total)} ms (db ${Math.round(dbMsOf(rec))} ms, ${rec.queries} queries)`);
  });

  current.run(rec, next);
}

