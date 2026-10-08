import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { SKIN_VERSION, verifySession, waitForVerifiedSession } from "../scripts/injector.mjs";

// Match the generated contract exactly; stale shorthand selectors must not
// silently turn a present composer or settings surface into a missing anchor.
const selectorContract = JSON.parse(readFileSync(new URL("../assets/selectors.json", import.meta.url), "utf8"));
const selectorFor = (key) => selectorContract.selectors.find((entry) => entry.key === key).selector;
const selectors = {
  shell: selectorFor("shell-main"),
  sidebar: selectorFor("left-panel"),
  composer: selectorFor("composer-chrome"),
  homeIcon: selectorFor("home-icon"),
  home: selectorFor("home-route"),
  gameSource: selectorFor("game-source"),
  suggestions: selectorFor("home-suggestions"),
  settings: selectorFor("appearance-radio"),
  settingsPanel: selectorFor("settings-panel"),
  themePreview: '[data-testid="theme-preview"]',
};

function makeRect(width = 800, height = 600, x = 0, y = 0) {
  return { x, y, width, height, right: x + width, bottom: y + height };
}

function makeElement({
  rect = makeRect(),
  style = {},
  checkVisibility = true,
  isConnected = true,
} = {}) {
  return {
    isConnected,
    classList: [],
    childNodes: [],
    textContent: "",
    _style: {
      display: "block",
      visibility: "visible",
      contentVisibility: "visible",
      opacity: "1",
      color: "rgb(0, 0, 0)",
      ...style,
    },
    getBoundingClientRect: () => rect,
    checkVisibility: () => checkVisibility,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function makeHome(options = {}) {
  const home = makeElement(options);
  const hero = makeElement();
  home.children = [hero];
  home.firstElementChild = hero;
  return home;
}

function makeDomFixture({
  scope = { level: "L1", baseState: "thread", missingL1: [] },
  shell = makeElement(),
  sidebar = makeElement(),
  composer = makeElement(),
  settings = null,
  home = null,
  visibilityState = "visible",
  viewportWidth = 1280,
  viewportHeight = 800,
} = {}) {
  const styleNode = {};
  const documentElement = {
    scrollWidth: viewportWidth,
    clientWidth: viewportWidth,
    scrollHeight: viewportHeight,
    clientHeight: viewportHeight,
    getAttribute: (name) => name === "data-dream-skin" ? "active" : null,
  };
  const document = {
    documentElement,
    adoptedStyleSheets: [],
    visibilityState,
    querySelector(selector) {
      if (selector === selectors.shell) return shell;
      if (selector === selectors.sidebar) return sidebar;
      if (selector === selectors.composer) return composer;
      if (selector === selectors.settings || selector === selectors.settingsPanel || selector === selectors.themePreview) return settings;
      if (selector === selectors.home) return home;
      if (selector === selectors.homeIcon ||
          selector === selectors.gameSource || selector === selectors.suggestions) return null;
      return null;
    },
    querySelectorAll(selector) {
      const match = this.querySelector(selector);
      return match == null ? [] : Array.isArray(match) ? match : [match];
    },
    getElementById: (id) => id === "codex-dream-skin-style" ? styleNode : null,
  };
  const window = {
    __CODEX_DREAM_SKIN_STATE__: {
      version: SKIN_VERSION,
      themeId: "fixture-theme",
      revision: "fixture-revision",
      styleMode: "style",
      styleNode,
      scope,
    },
  };
  return {
    document,
    window,
    innerWidth: viewportWidth,
    innerHeight: viewportHeight,
    getComputedStyle: (node) => node?._style ?? {},
  };
}

function makeSession({
  dom = makeDomFixture(),
  evaluateErrors = [],
  nativeResponse = {
    windowId: 41,
    bounds: { width: 1280, height: 800, windowState: "normal" },
  },
} = {}) {
  let evaluateCount = 0;
  return {
    target: { id: "page-main" },
    get evaluateCount() { return evaluateCount; },
    async evaluate(expression) {
      const error = evaluateErrors[evaluateCount];
      evaluateCount += 1;
      if (error) throw error;
      return vm.runInNewContext(expression, dom);
    },
    async send(method, params) {
      assert.equal(method, "Browser.getWindowForTarget");
      assert.deepEqual(params, { targetId: "page-main" });
      return nativeResponse;
    },
  };
}

async function verify(overrides = {}) {
  return verifySession(
    makeSession(overrides),
    "fixture-theme",
    "fixture-revision",
  );
}

test("visible L1 renderer passes exact macOS verification", async () => {
  const result = await verify();
  assert.equal(result.pass, true);
  assert.equal(result.shell.visible, true);
  assert.equal(result.sidebar.visible, true);
});

test("CSS-hidden, detached, and offscreen anchors cannot satisfy L1", async () => {
  const cases = [
    ["display none", makeElement({ style: { display: "none" } })],
    ["visibility hidden", makeElement({ style: { visibility: "hidden" } })],
    ["visibility collapse", makeElement({ style: { visibility: "collapse" } })],
    ["content-visibility hidden", makeElement({ style: { contentVisibility: "hidden" } })],
    ["opacity zero", makeElement({ style: { opacity: "0" } })],
    ["checkVisibility false", makeElement({ checkVisibility: false })],
    ["detached", makeElement({ isConnected: false })],
    ["offscreen right", makeElement({ rect: makeRect(200, 200, 1280, 20) })],
    ["offscreen left", makeElement({ rect: makeRect(200, 200, -200, 20) })],
    ["offscreen below", makeElement({ rect: makeRect(200, 200, 20, 800) })],
  ];

  for (const [label, shell] of cases) {
    const result = await verify({ dom: makeDomFixture({ shell }) });
    assert.equal(result.pass, false, label);
    assert.equal(result.checks.structurePass, false, label);
    assert.equal(result.shell.visible, false, label);
  }
});

test("transient Runtime.evaluate failures are retried inside the bounded deadline", async () => {
  const session = makeSession({
    evaluateErrors: [new Error("Execution context was destroyed during navigation")],
  });
  const result = await waitForVerifiedSession(
    session,
    100,
    "fixture-theme",
    "fixture-revision",
    1,
  );
  assert.equal(result.pass, true);
  assert.equal(session.evaluateCount, 2);
});

test("verification rethrows the last transient error when no sample succeeds", async () => {
  const session = makeSession();
  session.evaluate = async () => {
    throw new Error("Execution context stayed unavailable");
  };
  await assert.rejects(
    waitForVerifiedSession(session, 15, "fixture-theme", "fixture-revision", 1),
    /Execution context stayed unavailable/,
  );
});


test("retained hidden tabs cannot mask visible shell anchors or create a Home route", async () => {
  const hidden = makeElement({ rect: makeRect(0, 0), style: { display: "none" } });
  const hiddenHome = makeHome({ rect: makeRect(0, 0), style: { display: "none" } });
  const visible = makeElement({ rect: makeRect(640, 480, 20, 20) });
  const response = await verify({ dom: makeDomFixture({
    shell: [hidden, visible], sidebar: [hidden, visible], composer: [hidden, visible],
    home: hiddenHome,
  }) });
  const result = response;
  assert.equal(result.homePresent, false);
  assert.equal(result.shell.width, 640);
  assert.equal(result.sidebar.visible, true);
  assert.equal(result.composer.visible, true);
  assert.equal(result.pass, true, "A visible non-Home surface must ignore retained hidden Home DOM");
});

test("a stale Home scope with only hidden Home DOM still fails closed", async () => {
  const response = await verify({ dom: makeDomFixture({
    scope: { level: "L1", baseState: "home", missingL1: [] },
    home: makeHome({ rect: makeRect(0, 0), style: { display: "none" } }),
  }) });
  const result = response;
  assert.equal(result.homePresent, false);
  assert.equal(result.pass, false);
});

test("visible Home wins over an earlier retained hidden Home", async () => {
  const response = await verify({ dom: makeDomFixture({
    scope: { level: "L1", baseState: "home", missingL1: [] },
    home: [
      makeHome({ rect: makeRect(0, 0), style: { display: "none" } }),
      makeHome({ rect: makeRect(900, 650, 20, 20) }),
    ],
  }) });
  const result = response;
  assert.equal(result.homePresent, true);
  assert.equal(result.pass, true);
});
