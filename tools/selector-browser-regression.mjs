// Optional real-browser regression for the selector contract. Requires Playwright
// and its Chromium browser (or PLAYWRIGHT_BROWSER_CHANNEL=msedge on Windows).
// Run: node tools/selector-browser-regression.mjs
// PLAYWRIGHT_MODULE may point at an existing Playwright index.mjs installation.
// This synthetic DOM is reconstructed from the 26.1002.52244 Windows bundle;
// passing it is not a live Codex injection, video, or restore smoke test.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright";
const { chromium } = await import(playwrightModule);
const contract = JSON.parse(await fs.readFile(new URL("./selectors.json", import.meta.url), "utf8"));
const selectors = Object.fromEntries(contract.selectors.map(({ key, selector }) => [key, selector]));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}),
});
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html data-dream-skin="active"><body>
    <aside class="app-shell-left-panel" id="sidebar"></aside>
    <main data-app-shell-main-surface="default" id="main">
      <header data-app-shell-header-edge-scroll="true" id="header"></header>
      <div role="main" id="home"><span data-testid="home-icon"></span>
        <div data-codex-composer-root data-composer-placement="home" id="composer-container">
          <div data-composer-rail-item="controls" data-composer-placement="home"
               data-composer-rail-placement="above" id="home-rail"><button>Project</button></div>
          <div class="_ComposerLayoutRoot_fixture_2" id="composer"></div>
        </div>
      </div>
      <div data-composer-rail-item="controls" data-composer-placement="thread" id="thread-rail"></div>
      <div data-composer-rail-item="banner" id="banner-rail"></div>
      <div class="_homeUtilityBar_legacy_1" id="legacy-utility"></div>
      <div class="_ComposerHomeUtilityBar_previous_1" id="previous-utility"></div>
      <div class="_markdown_legacy_1" id="legacy-markdown">Legacy</div>
      <div class="_MarkdownRoot_fixture_2" id="current-markdown">Current</div>
      <div data-markdown-text-style="assistant-message" id="semantic-markdown">Semantic</div>
      <div class="_MarkdownTablePreview_fixture_2" id="table-preview">Preview</div>
    </main>
  </body></html>`);
  const hits = await page.evaluate((selectors) => Object.fromEntries(
    Object.entries(selectors).map(([key, selector]) => [key,
      [...document.querySelectorAll(selector)].map((node) => node.id).filter(Boolean)]),
  ), selectors);
  assert.deepEqual(hits["home-utility"], ["home-rail", "legacy-utility", "previous-utility"],
    "Utility must include old and current controls without selecting the composer root, thread rail, or banner");
  assert.deepEqual(hits.markdown, ["legacy-markdown", "current-markdown", "semantic-markdown"],
    "Markdown must include both module generations and semantic roots without selecting table previews");
  assert.deepEqual(hits["shell-main"], ["main"]);
  assert.deepEqual(hits["left-panel"], ["sidebar"]);
  assert.deepEqual(hits["header-tint"], ["header"]);

  for (const platform of ["macos", "windows"]) {
    const css = await fs.readFile(new URL(`../${platform}/assets/dream-skin.css`, import.meta.url), "utf8");
    const style = await page.addStyleTag({ content: css });
    const painted = await page.evaluate(() => ({
      utilityZ: getComputedStyle(document.querySelector("#home-rail")).zIndex,
      containerZ: getComputedStyle(document.querySelector("#composer-container")).zIndex,
      composerRadius: getComputedStyle(document.querySelector("#composer")).borderTopLeftRadius,
    }));
    assert.equal(painted.utilityZ, "3", `${platform}: the current rail receives utility CSS`);
    assert.notEqual(painted.containerZ, "3", `${platform}: the entire composer must not receive utility CSS`);
    assert.equal(painted.composerRadius, "22px", `${platform}: home composer rule parses with the extended alias`);
    await style.evaluate((node) => node.remove());
  }
  console.log("PASS: synthetic Codex 26.1002 selector DOM and both generated stylesheets in Chromium");
} finally {
  await browser.close();
}
