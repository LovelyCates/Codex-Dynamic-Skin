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
  // Exercise the real cascade for #309: a light themed foreground must beat
  // native dark text in wide full task mode, for every Markdown generation.
  await page.evaluate(() => {
    document.querySelector("#home").remove();
    // Live 26.1002 layout: the data attribute marks the whole conversation,
    // while the aria-hidden module node is the separate decorative fade.
    document.querySelector("#main").insertAdjacentHTML("beforeend", `
      <div data-app-shell-main-content-top-fade id="thread-content" style="display:flex;min-height:180px">
        <article>Fixture conversation</article>
        <div class="_ComposerLayoutRoot_fixture_2"><div contenteditable="true" id="thread-editor" style="min-width:160px;min-height:44px"></div></div>
      </div>
      <div class="_MainContentTopFade_fixture_2" aria-hidden="true" id="decorative-fade"></div>
      <div data-app-shell-main-content-top-fade aria-hidden="true" id="legacy-decorative-fade"></div>`);
    document.documentElement.setAttribute("data-dream-task-mode", "full");
    document.documentElement.setAttribute("data-dream-art-wide", "true");
    document.documentElement.style.setProperty("--ds-text", "rgb(237, 242, 250)");
    for (const id of ["legacy-markdown", "current-markdown", "semantic-markdown"]) {
      document.getElementById(id).classList.add("fixture-native-markdown");
    }
  });
  await page.addStyleTag({ content: ".fixture-native-markdown { color: rgb(1, 2, 3) !important; }" });
  for (const platform of ["macos", "windows"]) {
    const css = await fs.readFile(new URL(`../${platform}/assets/dream-skin.css`, import.meta.url), "utf8");
    const style = await page.addStyleTag({ content: css });
    const thread = await page.evaluate(() => {
      const editor = document.getElementById("thread-editor");
      const rect = editor.getBoundingClientRect();
      return {
        display: getComputedStyle(document.getElementById("thread-content")).display,
        editorVisible: editor.checkVisibility(), width: rect.width, height: rect.height,
        fade: getComputedStyle(document.getElementById("decorative-fade")).display,
        legacyFade: getComputedStyle(document.getElementById("legacy-decorative-fade")).display,
      };
    });
    assert.equal(thread.display, "flex", `${platform}: fade anchor must not hide the conversation`);
    assert.ok(thread.editorVisible && thread.width >= 160 && thread.height >= 44,
      `${platform}: the real editor remains laid out and visible`);
    assert.equal(thread.fade, "none", `${platform}: decorative module fade is still removed`);
    assert.equal(thread.legacyFade, "none", `${platform}: explicitly decorative legacy fade is removed`);
    for (const shell of ["dark", "light"]) {
      const foregrounds = await page.evaluate((shell) => {
        document.documentElement.setAttribute("data-dream-shell", shell);
        return ["legacy-markdown", "current-markdown", "semantic-markdown"].map((id) => {
          const computed = getComputedStyle(document.getElementById(id));
          return { id, color: computed.color, shadow: computed.textShadow };
        });
      }, shell);
      for (const foreground of foregrounds) {
        assert.equal(foreground.color, "rgb(237, 242, 250)",
          `${platform}/${shell}/${foreground.id}: full task mode must override native dark Markdown text`);
        assert.notEqual(foreground.shadow, "none",
          `${platform}/${shell}/${foreground.id}: full task mode must retain the contrast shadow`);
      }
    }
    await style.evaluate((node) => node.remove());
  }
  // A video paints behind the shell. Full mode must reveal it without also
  // removing the readable application-menu surface or unrelated card paint.
  await page.setContent(`<!doctype html><html data-dream-skin="active"
      data-dream-shell="light" data-dream-art-wide="true" data-dream-task-mode="full">
    <head><style>
      .fixture-native-control { color: rgb(1, 2, 3); }
      #video-main { min-height: 240px; }
    </style></head><body>
      <div class="_ApplicationMenuTopBar_fixture_1" id="application-topbar">
        <div role="menubar"><button role="menuitem" class="fixture-native-control" id="menu-control">File</button></div>
        <button class="fixture-native-control" id="window-control">Minimize</button>
      </div>
      <main data-app-shell-main-surface="default" id="video-main">
        <header data-app-shell-header-edge-scroll="true" id="video-header"></header>
        <div data-app-shell-main-content-top-fade id="video-thread" style="display:flex;min-height:180px">
          <div id="unrelated-card" class="bg-surface" style="background:rgb(12, 34, 56)">Ordinary card</div>
          <div data-thread-scroll-footer id="thread-footer">
            <div id="footer-whitebar" class="pointer-events-none absolute inset-x-0 bg-surface" style="background:rgb(255, 255, 255)"></div>
            <div id="footer-gradient" class="pointer-events-none absolute inset-x-0 bg-gradient-to-t from-surface" style="background:linear-gradient(rgb(255, 255, 255), transparent)"></div>
            <div class="_ComposerLayoutRoot_fixture_2"><div contenteditable="true" id="video-editor" style="min-width:160px;min-height:44px"></div></div>
          </div>
        </div>
      </main>
      <video id="codex-dream-skin-media" aria-hidden="true"></video>
    </body></html>`);
  const topbarMatches = await page.evaluate((selector) =>
    document.getElementById("application-topbar").matches(selector), selectors["header-tint"]);
  assert.ok(topbarMatches, "Current application topbar outside main receives the header contract");
  for (const platform of ["macos", "windows"]) {
    const css = await fs.readFile(new URL(`../${platform}/assets/dream-skin.css`, import.meta.url), "utf8");
    const style = await page.addStyleTag({ content: css });
    for (const mode of ["full", "off"]) {
      const painted = await page.evaluate((mode) => {
        document.documentElement.setAttribute("data-dream-task-mode", mode);
        document.documentElement.setAttribute("data-dream-art-task-mode", mode);
        const computed = (id) => getComputedStyle(document.getElementById(id));
        const editor = document.getElementById("video-editor");
        const rect = editor.getBoundingClientRect();
        return {
          mainColor: computed("video-main").backgroundColor,
          mainImage: computed("video-main").backgroundImage,
          menuColor: computed("application-topbar").backgroundColor,
          menuForeground: computed("menu-control").color,
          windowForeground: computed("window-control").color,
          expectedForeground: getComputedStyle(document.documentElement).getPropertyValue("--ds-text").trim(),
          card: computed("unrelated-card").backgroundColor,
          footerVisible: document.getElementById("thread-footer").checkVisibility(),
          footerWhitebarColor: computed("footer-whitebar").backgroundColor,
          footerGradientColor: computed("footer-gradient").backgroundColor,
          footerGradientImage: computed("footer-gradient").backgroundImage,
          editorVisible: editor.checkVisibility(), width: rect.width, height: rect.height,
        };
      }, mode);
      const alpha = (color) => color.startsWith("rgba(")
        ? Number(color.slice(color.lastIndexOf(",") + 1, -1).trim()) : 1;
      if (mode === "full") {
        assert.equal(alpha(painted.mainColor), 0, `${platform}: full video mode reveals video through main`);
        if (painted.mainImage !== "none") {
          const stops = painted.mainImage.match(/rgba?\([^)]*\)/g) ?? [];
          assert.ok(stops.length > 0 && stops.every((color) => alpha(color) < 1),
            `${platform}: full video mode permits only translucent gradient stops`);
        }
      } else {
        assert.ok(alpha(painted.mainColor) >= .9, `${platform}: off mode keeps an opaque main surface`);
      }
      assert.ok(alpha(painted.menuColor) >= .9, `${platform}/${mode}: menu controls retain readable backing`);
      // Resolve the token through a temporary element to compare canonical rgb,
      // independent of whether the shared theme declares hex or rgb values.
      const expectedColor = await page.evaluate((color) => {
        const probe = document.createElement("span");
        probe.style.color = color;
        document.body.appendChild(probe);
        const result = getComputedStyle(probe).color;
        probe.remove();
        return result;
      }, painted.expectedForeground);
      assert.equal(painted.menuForeground, expectedColor, `${platform}/${mode}: menu text uses theme foreground`);
      assert.equal(painted.windowForeground, expectedColor, `${platform}/${mode}: window control uses theme foreground`);
      assert.equal(painted.card, "rgb(12, 34, 56)", `${platform}/${mode}: unrelated card keeps native paint`);
      assert.equal(alpha(painted.footerWhitebarColor), 0, `${platform}/${mode}: empty footer whitebar is cleared`);
      assert.equal(alpha(painted.footerGradientColor), 0, `${platform}/${mode}: empty footer gradient color is cleared`);
      assert.equal(painted.footerGradientImage, "none", `${platform}/${mode}: empty footer gradient image is cleared`);
      assert.ok(painted.footerVisible, `${platform}/${mode}: footer containing the editor stays visible`);
      assert.ok(painted.editorVisible && painted.width >= 160 && painted.height >= 44,
        `${platform}/${mode}: video transparency preserves usable editor geometry`);
    }
    await style.evaluate((node) => node.remove());
  }
  console.log("PASS: synthetic Codex 26.1002 selector DOM and both generated stylesheets in Chromium");
} finally {
  await browser.close();
}
