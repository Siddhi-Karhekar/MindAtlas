// Runs in a worker thread (see extractInWorker.js): checks one uploaded file
// and reads its text. Nothing here is specific to being a worker except how
// the file arrives and how the answer leaves.
import { parentPort, workerData } from "node:worker_threads";
import { extractDocument } from "./documentText.js";
import { checkUploadContent } from "./uploadCheck.js";

const { originalname, mimetype, bytes, kind } = workerData;
try {
  const file = { originalname, mimetype, buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  await checkUploadContent(file, kind);
  const { text, blocks } = await extractDocument(file, kind);
  parentPort.postMessage({ ok: true, text, blocks });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err?.message || err) });
}
