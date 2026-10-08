import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.join(app, "CodexDreamSkin.Manager");
const project = fs.readFileSync(path.join(projectRoot, "CodexDreamSkin.Manager.csproj"), "utf8");
const provisioner = fs.readFileSync(path.join(projectRoot, "RuntimeProvisioner.cs"), "utf8");
const resources = [...project.matchAll(/<EmbeddedResource Include="([^"]+)" LogicalName="([^"]+)"/g)]
  .map(([, source, name]) => ({ source, name }));
const mappings = [...provisioner.matchAll(/\["([^"]+)"\] = @"([^"]+)"/g)]
  .map(([, name, destination]) => ({ name: `DreamSkin.${name}`, destination }));

test("every embedded engine file is nonempty and extracted to its original relative path", () => {
  assert.equal(new Set(resources.map(item => item.name)).size, resources.length);
  assert.equal(new Set(mappings.map(item => item.destination)).size, mappings.length);
  assert.deepEqual(resources.map(item => item.name).sort(), mappings.map(item => item.name).sort());
  for (const item of resources.filter(item => item.name.startsWith("DreamSkin.Engine."))) {
    const source = path.resolve(projectRoot, ...item.source.split("\\"));
    assert.ok(fs.statSync(source).size > 0, `${item.source} is empty`);
    const expected = path.relative(path.resolve(app, ".."), source).split(path.sep).join("\\");
    assert.equal(mappings.find(map => map.name === item.name).destination, `payload\\${expected}`);
  }
});

test("portable payload satisfies the managed installer required-file contract", () => {
  const common = fs.readFileSync(path.resolve(app, "../scripts/common-windows.ps1"), "utf8");
  const requiredBlock = common.match(/\$required = @\(([\s\S]*?)\r?\n  \)/);
  assert.ok(requiredBlock, "installer required-file contract is missing");
  const required = [...requiredBlock[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(required.length >= 20, "installer contract unexpectedly shrank");
  for (const file of required) {
    assert.ok(mappings.some(item => item.destination === `payload\\${file}`), `manager omits ${file}`);
  }
});

test("all relative imports in embedded JavaScript resolve inside the portable payload", () => {
  const sources = new Set(resources.filter(item => item.name.startsWith("DreamSkin.Engine."))
    .map(item => path.resolve(projectRoot, ...item.source.split("\\"))));
  for (const source of sources) {
    if (!/\.(mjs|js)$/.test(source)) continue;
    const text = fs.readFileSync(source, "utf8");
    for (const match of text.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
      const dependency = path.resolve(path.dirname(source), match[1]);
      assert.ok(sources.has(dependency), `${path.basename(source)} is missing dependency ${match[1]}`);
    }
  }
});
