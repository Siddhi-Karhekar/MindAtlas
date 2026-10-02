// Loads the embedding model once and reports what it costs on this machine:
// how long it takes to load, how much memory it holds, how fast it is - and
// shows it telling subject sentences from administrative ones.
// Run with:  npm run semantic:check   (from server/)
import "dotenv/config";
import { centroid, cosine, getEmbedder, semanticStatus } from "../src/services/embeddings.js";

const mb = () => Math.round(process.memoryUsage().rss / 1e6);
const before = mb();
const started = Date.now();
// the first run downloads the model (about 25 MB), so allow it time
const embedder = await getEmbedder({ waitMs: 180_000 });
if (!embedder) {
  console.log("The embedding model is NOT active:", semanticStatus().reason);
  console.log("The server still works: questions are ranked by rules instead.");
  process.exit(0);
}
console.log(`Model:   ${embedder.model}`);
console.log(`Loaded:  ${((Date.now() - started) / 1000).toFixed(1)} s (includes the download the first time)`);
console.log(`Memory:  ${before} MB -> ${mb()} MB`);

const subject = [
  "A distributed system is a collection of independent computers that appears to its users as a single coherent system.",
  "Fault tolerance allows the system to continue operating when some of its nodes fail.",
  "In message passing, processes communicate by sending and receiving messages over a channel.",
];
const other = [
  "Students should bring their own laptops to every laboratory session.",
  "The examination will be held in the last week of November in the seminar hall.",
];
const t = Date.now();
const vectors = await embedder.embed([...subject, ...other]);
const centre = centroid(vectors.slice(0, subject.length));
console.log(`Speed:   ${subject.length + other.length} sentences in ${Date.now() - t} ms\n`);
console.log("Closeness to the topic (subject sentences should score well above the others):");
[...subject, ...other].forEach((s, i) => console.log(`  ${cosine(vectors[i], centre).toFixed(2)}  ${i < subject.length ? "subject" : "other  "}  ${s.slice(0, 70)}`));
console.log(`\nPeak memory: ${mb()} MB. The model is active for test generation.`);
process.exit(0);
