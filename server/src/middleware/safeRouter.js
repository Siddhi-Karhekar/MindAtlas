// An Express router whose handlers may be async and may throw.
//
// Express 4 does not look at what a handler returns, so an `async` handler
// that throws leaves a rejected promise nobody is waiting for - and Node ends
// the whole process on an unhandled rejection. One bad request (a password
// sent as an object instead of text was enough) took the server down for
// everyone. Every router in routes/ is made with safeRouter(): a rejection is
// passed to next(), and so to the error handler in index.js, like any other
// error.
//
// It also refuses ids that are not ids before a handler sees them. Every
// record id in this app is 24 hexadecimal characters (db/ids.js); anything
// else in an :id position cannot name a record, so it is "not found".

import { Router } from "express";
import { isId } from "./validate.js";

const METHODS = ["use", "all", "get", "post", "put", "patch", "delete"];
const ID_PARAMS = ["id", "noteId"];

const wrap = (fn) => {
  // error-handling middleware (4 arguments) and anything that is not a
  // function (a path, a sub-router's options) are left alone
  if (typeof fn !== "function" || fn.length > 3) return fn;
  // a sub-router is itself a function with (req, res, next): it handles its own
  if (typeof fn.handle === "function" && typeof fn.use === "function") return fn;
  return function safeHandler(req, res, next) {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === "function") out.catch(next);
    } catch (err) {
      next(err);
    }
  };
};

/** `fn` made safe to use as middleware anywhere (app.get, app.use ...). */
export const safe = wrap;

export function safeRouter(options) {
  const router = Router(options);
  for (const method of METHODS) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map((a) => (Array.isArray(a) ? a.map(wrap) : wrap(a))));
  }
  for (const name of ID_PARAMS) {
    router.param(name, (req, res, next, value) => {
      if (!isId(value)) return res.status(404).json({ error: "not found" });
      next();
    });
  }
  return router;
}
