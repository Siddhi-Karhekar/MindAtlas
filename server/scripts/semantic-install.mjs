// Installs the optional embedding model library into server/semantic/.
// Run with:  npm run semantic:install   (from server/)
//
// It is kept out of the main install on purpose - see services/embeddings.js.
// ONNXRUNTIME_NODE_INSTALL=skip stops the ONNX runtime from also downloading
// its GPU (CUDA) libraries on Linux: several hundred megabytes this app never
// uses, since the model runs on the CPU.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../semantic", import.meta.url));
console.log("Installing the embedding model library into server/semantic/ (about 500 MB on disk) ...");
const result = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
  cwd: dir,
  stdio: "inherit",
  shell: true, // npm is npm.cmd on Windows
  env: { ...process.env, ONNXRUNTIME_NODE_INSTALL: "skip" },
});
if (result.status !== 0) {
  console.error("\nInstall failed. Nothing else is affected: the server keeps using rule-based ranking.");
  process.exit(result.status || 1);
}
console.log("\nInstalled. Checking that the model loads ...\n");
const check = spawnSync(process.execPath, [fileURLToPath(new URL("./semantic-check.mjs", import.meta.url))], { stdio: "inherit" });
process.exit(check.status || 0);
