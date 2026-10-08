import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const injectorPath = path.resolve(here, "../scripts/injector.mjs");
let versionRequests = 0;
let port = 0;

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/json/list") {
    response.end("[]");
    return;
  }
  if (request.url === "/json/version") {
    versionRequests += 1;
    response.end(JSON.stringify({
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test-browser`,
    }));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
port = server.address().port;

const runMode = (mode) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    injectorPath,
    mode,
    "--port", String(port),
    "--browser-id", "test-browser",
    "--timeout-ms", "250",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code, stdout, stderr }));
});

try {
  for (const mode of ["--verify", "--once", "--remove"]) {
    const requestsBefore = versionRequests;
    const result = await runMode(mode);
    assert.notEqual(result.code, 0, `${mode} should time out because the fixture exposes no page targets.`);
    assert.ok(versionRequests > requestsBefore,
      `${mode} must pass its expected Browser ID into one-shot target discovery.`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /options is not defined/,
      `${mode} must not reference a CLI options binding outside its lexical scope.`);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("PASS: Windows verify, once, and remove pass Browser ID explicitly into one-shot discovery.");

const injectorSource = await fs.readFile(injectorPath, "utf8");
function sourceBetween(start, end) {
  const startIndex = injectorSource.indexOf(start);
  const endIndex = injectorSource.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Missing production function: ${start}`);
  return injectorSource.slice(startIndex, endIndex).replace(/^export /, "");
}
const applySource = sourceBetween("async function applyToSession(", "export function earlyPayloadFor(");
const bypassSource = sourceBetween("export async function setStreamCspBypass(", "async function applyToSession(");
const oneShotSource = sourceBetween("async function runOneShot(", "async function runWatch(");

async function runConnectedFixture({ mode = "once", reload = false, mediaType = "image", source = oneShotSource } = {}) {
  const evaluated = [];
  const commands = [];
  const transferred = [];
  const reports = [];
  let closed = false;
  const loadedPayload = {
    payload: "window.__fixtureSkinApplied = true;",
    theme: { id: "fixture-theme", name: "Fixture theme" },
    revision: "fixture-revision",
    mediaType,
    mediaPath: "fixture.mp4",
    mediaMime: "video/mp4",
    mediaSize: 123,
  };
  const session = {
    async evaluate(expression) {
      // Match Runtime.evaluate's required expression contract. JSON serialization
      // omits undefined, which is precisely what the former string argument caused.
      const request = JSON.parse(JSON.stringify({ method: "Runtime.evaluate", params: { expression } }));
      assert.equal(typeof request.params.expression, "string", "Runtime.evaluate requires a string expression");
      evaluated.push(request.params.expression);
      return true;
    },
    async send(method, params) {
      commands.push({ method, params });
      return {};
    },
    close() { closed = true; },
  };
  const context = vm.createContext({
    console: { log: (message) => reports.push(JSON.parse(message)) },
    process: { exitCode: 0 },
    setTimeout: (callback) => { callback(); return 0; },
    connectCodexTargets: async () => [{ target: { id: "fixture-target" }, session, probe: { markers: { shell: true } } }],
    nextOperationToken: () => "fixture-operation",
    bestEffortOperationUi: async () => true,
    presentOperationUi: async () => true,
    loadPayload: async () => loadedPayload,
    transferVideoToSession: async (actualSession, actualPayload) => {
      assert.equal(actualSession, session);
      assert.equal(actualPayload, loadedPayload, "video transfer must receive the loaded payload object and metadata");
      transferred.push(actualPayload);
    },
    waitForVerifiedSession: async (actualSession, targetId, timeoutMs, themeId, revision) => {
      assert.equal(actualSession, session);
      assert.equal(targetId, "fixture-target");
      assert.equal(themeId, loadedPayload.theme.id);
      assert.equal(revision, loadedPayload.revision);
      return { pass: true };
    },
  });
  vm.runInContext(`${bypassSource}\n${applySource}\n${source}`, context);
  await context.runOneShot({ mode, reload, port: 9335, timeoutMs: 250, browserId: "test-browser" });
  assert.equal(closed, true, "one-shot must close its CDP session");
  return { evaluated, commands, transferred, report: reports.at(-1), exitCode: context.process.exitCode, loadedPayload };
}

for (const options of [
  { mode: "once", reload: false, applications: 1 },
  { mode: "once", reload: true, applications: 2 },
  { mode: "verify", reload: true, applications: 1 },
]) {
  test(`connected --${options.mode}${options.reload ? " --reload" : ""} applies the loaded payload`, async () => {
    const result = await runConnectedFixture(options);
    assert.equal(result.exitCode, 0, JSON.stringify(result.report));
    assert.equal(result.report.targets[0].result.pass, true);
    assert.deepEqual(result.evaluated, Array(options.applications).fill(result.loadedPayload.payload));
    assert.equal(result.commands.filter(item => item.method === "Page.reload").length, options.reload ? 1 : 0);
    assert.equal(result.commands.find(item => item.method === "Page.setBypassCSP")?.params.enabled, false);
  });
}

test("one-shot video and reload preserve the loaded media metadata", async () => {
  const result = await runConnectedFixture({ mode: "once", reload: true, mediaType: "video" });
  assert.equal(result.exitCode, 0, JSON.stringify(result.report));
  assert.equal(result.transferred.length, 2);
});

test("both historical string-argument regressions are rejected by the CDP fixture", async () => {
  const call = "await applyToSession(session, loadedPayload);";
  const matches = [...oneShotSource.matchAll(/await applyToSession\(session, loadedPayload\);/g)];
  assert.equal(matches.length, 2, "expected initial and post-reload application paths");
  for (const [index, options] of [[0, { mode: "once" }], [1, { mode: "verify", reload: true }]]) {
    const offset = matches[index].index;
    // Mutate only the in-memory production function, never the checked-out runtime.
    const historical = (oneShotSource.slice(0, offset) + "await applyToSession(session, payload);" +
      oneShotSource.slice(offset + call.length)).replace("  const results = [];", "  const payload = loadedPayload?.payload;\n  const results = [];");
    const result = await runConnectedFixture({ ...options, source: historical });
    assert.equal(result.exitCode, 2, `historical call ${index + 1} must fail`);
    assert.match(result.report.targets[0].error, /Runtime.evaluate requires a string expression/);
    assert.equal(result.evaluated.length, 0);
  }
});
