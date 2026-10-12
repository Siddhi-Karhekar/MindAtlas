// Reading an uploaded document on a thread of its own.
//
// The readers (the PDF parser, the Word and PowerPoint unzippers, the text
// decoder) run on whatever file a student sends. A file built to make one of
// them loop for minutes, or one that is merely enormous, would otherwise hold
// the single thread that answers every other student's requests. So each file
// is read in a worker thread, and the worker is given:
//   - a time limit: when it runs out the worker is stopped and the upload is
//     refused. The server itself never waits on it;
//   - a memory limit for what the readers build while parsing;
//   - company of at most one other: two files are read at a time and the rest
//     wait their turn, so uploads cannot take every CPU second there is.
// Pictures are not read here: OCR already runs in its own worker (ocr.js).

import { Worker } from "node:worker_threads";
import { envNumber } from "../config.js";

const WORKER = new URL("./extractWorker.js", import.meta.url);
const MAX_AT_ONCE = 2;
const MAX_WAITING = 20;

let running = 0;
const waiting = [];

function takeTurn() {
  if (running < MAX_AT_ONCE) {
    running += 1;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_WAITING) {
    const err = new Error("the server is busy reading other files - try again in a minute");
    err.busy = true;
    return Promise.reject(err);
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function endTurn() {
  const next = waiting.shift();
  if (next) next(); // the turn passes straight to the next in line
  else running -= 1;
}

/**
 * Check and read `file` ({ originalname, mimetype, buffer }) of `kind` (pdf,
 * docx, pptx, text). Resolves to { text, blocks }; rejects with an Error whose
 * message is for the student. `err.timedOut` marks a file that hit the time limit.
 */
export async function extractInWorker(file, kind) {
  await takeTurn();
  const timeoutMs = envNumber("EXTRACT_TIMEOUT_SECONDS", 25) * 1000;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(WORKER, {
        workerData: { originalname: file.originalname, mimetype: file.mimetype, bytes: new Uint8Array(file.buffer), kind },
        // what the parsers may allocate on the JavaScript heap (buffers the
        // unzipper fills are counted by uploadCheck.js instead)
        resourceLimits: { maxOldGenerationSizeMb: envNumber("EXTRACT_MAX_HEAP_MB", 256) },
      });
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => {});
        fn(value);
      };
      const timer = setTimeout(() => {
        const err = new Error("this file took too long to read - it may be damaged, or too complex. Try saving it again, or upload it in parts");
        err.timedOut = true;
        finish(reject, err);
      }, timeoutMs);
      worker.once("message", (m) => (m.ok ? finish(resolve, { text: m.text, blocks: m.blocks }) : finish(reject, new Error(m.error))));
      // out of memory, or a fault inside a parser: the worker died, the server did not
      worker.once("error", (err) => {
        console.error("[upload] reader stopped:", err?.code || err?.message);
        finish(reject, new Error("this file could not be read - it may be damaged, or too large to open safely"));
      });
      worker.once("exit", () => finish(reject, new Error("this file could not be read - it may be damaged")));
    });
  } finally {
    endTurn();
  }
}
