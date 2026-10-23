import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const env = { ...process.env, CHOKIDAR_USEPOLLING: "true" };
const children = [];
let stopping = false;

const stop = (exitCode = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 500).unref();
};

const start = (name, args) => {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`[dev:full] ${name} failed to start: ${error.message}`);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[dev:full] ${name} stopped (${signal ?? code ?? "unknown"})`);
    stop(code && code > 0 ? code : 1);
  });
};

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

start("Netlify Functions", [
  "node_modules/netlify-cli/bin/run.js",
  "functions:serve",
  "--offline",
  "--port",
  "9999",
]);
start("Vite", [
  "node_modules/vite/bin/vite.js",
  "--host",
  "localhost",
  "--port",
  "8888",
  "--strictPort",
]);
