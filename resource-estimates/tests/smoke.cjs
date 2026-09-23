const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const directory = path.resolve(__dirname, "..");
const base = process.env.DASHBOARD_URL || pathToFileURL(path.join(directory, "index.html")).href;
const artifacts = process.env.REVIEW_ARTIFACTS;
const results = [], errors = [], layouts = [];
const expected = {
  "1a": ["638", "324305", "132", "254", "252", "9", "220"],
  "1b": ["834", "338559", "172", "332", "330", "12", "240"],
  "2": ["395", "109357", "60", "171", "164", "4", "100"],
  "3a": ["405", "167655", "109", "108", "188", "5", "100"],
  "3b": ["1054", "492166", "278", "185", "591", "9", "220"],
  "4a": ["580", "185312", "113", "207", "260", "5", "140"],
  "4b": ["626", "191352", "107", "255", "264", "5", "140"],
  "4c": ["6232", "1698744", "742", "2631", "2859", "9", "220"]
};
const expectedIds = ["1a", "1b", "2", "3a", "3b", "4a", "4b", "4c"];
const readingTabs = ["Overview", "Resource footprint", "All metrics", "Updates & outlook"];
const sourceColors = {
  specification: ["green", "rgb(16, 124, 16)"], qubits: ["green", "rgb(16, 124, 16)"],
  operations: ["amber", "rgb(166, 122, 0)"], correctness: ["red", "rgb(192, 0, 0)"],
  hardware: ["blue", "rgb(15, 108, 189)"]
};
let browser;
const urlFor = (route, params = {}, origin = base) => {
  const url = new URL(origin);
  url.search = new URLSearchParams(params).toString();
  url.hash = route;
  return url.href;
};
const text = async (page, selector) => (await page.locator(selector).innerText()).replace(/\s+/g, " ").trim();
const nav = (page, route) => page.locator(`.main-nav [data-route="${route}"]`).click();
const editFrom = async (page, route = "edit") => {
  await nav(page, route === "write" ? "updates" : route === "edit" ? "metrics" : "overview");
  await page.locator(`[data-edit-route="${route}"]`).first().click();
};
const field = (page, key) => page.locator(`[data-written="${key}"]`);
const contextField = (page, key) => page.locator(`[data-context="${key}"]`);
const countField = (page, key, id = "1a") => page.locator(`[data-workload-id="${id}"][data-field="${key}"]`);
const snapshot = async (page, id) => {
  await page.locator(".snapshot-picker > summary").click();
  await page.selectOption("#snapshot-select", id);
};
const details = page => page.locator("#resource-details > summary").click();
const contrastRatio = (first, second) => {
  const luminance = color => {
    const [red, green, blue] = color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(value => {
      const component = Number(value) / 255;
      return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

async function open(url = urlFor("overview"), options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.stack));
  await page.goto(url);
  await page.locator("h1").waitFor();
  return { context, page };
}

async function check(name, action) {
  await action();
  results.push(name);
  console.log(`PASS ${name}`);
}

async function suppliedData() {
  const { context, page } = await open();
  try {
    const data = await page.evaluate(() => window.RESOURCE_DATA);
    assert.deepEqual(data.workloads.map(item => item.id), expectedIds);
    assert.deepEqual(data.systems.map(system => system.name), [
      "Magnet Models", "Laser Models (Dicke)",
      "Model Hamiltonian Energy Estimation (Hubbard Model)", "Small Chemistry Problems"
    ]);
    for (const item of data.workloads) {
      assert.equal(item.snapshots.length, 1, "No fabricated historical samples.");
      const record = item.snapshots[0];
      assert.equal(record.asOf, "2026-09-04");
      assert.equal(record.savedAt, null);
      assert.equal(record.owner, "");
      assert.equal(record.context.runtimeHours, "");
      assert.equal(record.context.targetPhysicalQubits, "");
      assert.deepEqual(data.fields.map(field => record.metrics[field.key]), expected[item.id]);
      assert.equal(BigInt(record.metrics.nonClifford) + BigInt(record.metrics.clifford1) + BigInt(record.metrics.clifford2), BigInt(record.metrics.logicalOps));
    }
    assert.equal(data.updates.length, 0);
    assert.equal(data.milestones.length, 0);
    assert.equal(await page.locator("body").getAttribute("data-storage"), "read-only");
    assert.equal(await text(page, "#storage-caption"), "Published review - view only");
    assert.equal(await page.locator("[data-mode],.demo-switch,[data-edit-route]").count(), 0);
    assert.deepEqual(await page.locator(".main-nav a").allTextContents(), readingTabs);
    assert.deepEqual(await page.locator("[data-metric]").allTextContents(), ["638", "9"]);
    assert.ok(!/Dummy|fictional|120M|App 1a/.test(await text(page, "body")));
    const order = await page.locator(".candidate-controls select").evaluateAll(selects => selects.map(select => select.id));
    assert.deepEqual(order, ["candidate-select", "system-filter"]);
    assert.equal(await page.locator("#candidate-select option").count(), 8);
    assert.match(await text(page, ".estimate-meta"), /Spin Dynamics Floquet-3x3.*4 Sept? 2026/);
    assert.match(await text(page, ".chart-caption"), /One dated snapshot/);
    assert.ok(!/\b[134][abc]\b|\bSystem [1-4]\b/.test(await text(page, ".candidate-controls")), "Application and model labels must use names only.");
    assert.equal(await page.locator(".chart .chart-point").count(), 2);
    assert.equal(await page.locator(".roadmap-stages > li").count(), 5);
    assert.match(await text(page, ".roadmap-panel"), /Application Roadmap and Progress/);
    assert.equal(await page.locator(".stage-status").getByText("Complete", { exact: true }).count(), 0);
    for (const [id, [name, color]] of Object.entries(sourceColors)) {
      assert.equal(await page.locator(`[data-roadmap-stage="${id}"]`).getAttribute("data-color"), name);
      assert.equal(await page.locator(`[data-roadmap-stage="${id}"] .stage-marker`).evaluate(element => getComputedStyle(element).backgroundColor), color);
    }
    const contrast = await page.locator(".roadmap-stages").evaluate(element => ({
      background: getComputedStyle(document.documentElement).backgroundColor,
      title: getComputedStyle(element.querySelector(".stage-title")).color,
      status: getComputedStyle(element.querySelector(".stage-status")).color
    }));
    assert.ok(contrastRatio(contrast.title, contrast.background) >= 4.5);
    assert.ok(contrastRatio(contrast.status, contrast.background) >= 4.5);
    for (const [, color] of Object.values(sourceColors)) assert.ok(contrastRatio(color, contrast.background) >= 3, "Source stage markers retain non-text contrast.");
    const assessments = await page.locator(".stage-status").allTextContents();
    await page.selectOption("#overview-mode", "global");
    assert.deepEqual(await page.locator(".stage-status").allTextContents(), assessments);
    assert.deepEqual(await page.locator("[data-roadmap-stage]").evaluateAll(stages => stages.map(stage => stage.dataset.color)), ["green", "green", "amber", "red", "blue"]);
    await page.selectOption("#overview-mode", "candidate");
    await details(page);
    assert.match(await text(page, "#resource-details"), /324,305/);
    assert.match(await text(page, "#resource-details"), /nearest pi\/2 multiple/);
    assert.match(await text(page, "#resource-details"), /PHYSICAL_MOVE.*separately from the SWAP/);
    assert.match(await text(page, "#resource-details"), /exact exclusion filter were not supplied/);
    await nav(page, "metrics");
    const rows = await page.locator("#all-metrics-table tbody tr").evaluateAll(rows => rows.map(row => [...row.querySelectorAll("td")].map(cell => cell.textContent.replaceAll(",", "").trim())));
    assert.deepEqual(rows, expectedIds.map(id => expected[id]));
    await nav(page, "updates");
    assert.equal(await page.locator("[data-update-id],[data-milestone-id]").count(), 0);
    assert.match(await text(page, "main"), /sprint-based plans/);
    await page.goto(urlFor("edit", { mode: "engineering" }));
    assert.match(await text(page, "main"), /Published review.*view only/);
    assert.equal(await page.locator("#save-updates,[data-field]").count(), 0);
    await page.goto(urlFor("records"));
    assert.equal(await page.locator('a[href="/api/database"]').count(), 0);
    assert.match(await text(page, "main"), /does not expose raw submissions or database exports/);
  } finally { await context.close(); }
}

async function links() {
  const { context, page } = await open();
  try {
    await page.selectOption("#system-filter", "3");
    assert.equal(await page.locator("#candidate-select option").count(), 2);
    await page.selectOption("#candidate-select", "3b");
    const selected = page.url();
    const fresh = await open(selected);
    assert.equal(await fresh.page.inputValue("#candidate-select"), "3b");
    assert.equal(await fresh.page.inputValue("#system-filter"), "3");
    assert.deepEqual(await fresh.page.locator("[data-metric]").allTextContents(), ["1.1K", "9"]);
    await fresh.context.close();
    await nav(page, "compare");
    assert.equal(await text(page, "h1"), "Logical and physical resource requirements");
    assert.equal(await page.title(), "Resource footprint - Resource estimates");
    await page.goBack();
    assert.equal(page.url(), selected);
    await page.goBack();
    assert.equal(await page.inputValue("#candidate-select"), "3a");
    await page.goForward();
    assert.equal(page.url(), selected);
    await page.locator(".snapshot-picker > summary").click();
    await page.keyboard.press("Escape");
    assert.ok(!await page.locator("#snapshot-select").isVisible());
    const prevented = await page.locator('.main-nav [data-route="compare"]').evaluate(link => {
      const click = new MouseEvent("click", { ctrlKey: true, bubbles: true, cancelable: true });
      link.dispatchEvent(click);
      return click.defaultPrevented;
    });
    assert.equal(prevented, false);
    await page.locator("#share-action").click();
    const shared = new URL(await page.inputValue("#share-url"));
    assert.equal(shared.hostname, "rohit-2002-28.github.io");
    assert.equal(shared.searchParams.get("candidate"), "3b");
    assert.equal(shared.searchParams.get("snapshot"), "source-3b-v2");
    await page.locator('[data-action="close-share"]').click();
    for (const params of [{ candidate: "App 2c" }, { snapshot: "does-not-exist" }, { candidate: "3b", system: "1" }, { snapshot: "" }, { overview: "unknown" }]) {
      await page.goto(urlFor("overview", params));
      assert.equal(await page.locator("[data-metric]").count(), 0);
      assert.ok(await page.locator(".unavailable-view").isVisible());
      await page.locator(".unavailable-view a").click();
      assert.equal(await text(page, "h1"), "Resource overview");
    }
    for (const route of ["edit", "write", "roadmap", "guide", "compare"]) {
      for (const legacyMode of ["engineering", "leadership"]) {
        await page.goto(urlFor(route, { mode: legacyMode, candidate: "3b", system: "3" }));
        await page.locator("h1").waitFor();
        assert.ok(!await page.locator('[role="alert"]').count(), `Known legacy ${route}/${legacyMode} URL must recover safely.`);
        assert.equal(new URL(page.url()).hash, `#${route}`);
        assert.equal(new URL(page.url()).searchParams.get("candidate"), "3b");
        assert.equal(new URL(page.url()).searchParams.has("mode"), false);
        assert.deepEqual(await page.locator(".main-nav a").allTextContents(), readingTabs);
        assert.equal(await page.locator("[data-edit-route]").count(), 0);
        if (["edit", "write", "roadmap"].includes(route)) assert.equal(await page.locator("form,input,textarea").count(), 1, "Only the shared readonly link field exists; editor inputs are absent.");
      }
    }
  } finally { await context.close(); }
}

async function plotMapping() {
  const { context, page } = await open(urlFor("compare"));
  try {
    for (const kind of ["qubits", "operations"]) {
      const points = await page.locator(`[data-scatter="${kind}"] [data-point]`).evaluateAll(points => points.map(point => ({
        id: point.dataset.point, x: point.dataset.x, y: point.dataset.y, cx: Number(point.dataset.cx), cy: Number(point.dataset.cy)
      })));
      const axes = await page.locator(`[data-scatter="${kind}"]`).evaluate(svg => ({ ...svg.dataset, width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height }));
      assert.equal(points.length, 8);
      assert.ok(!/\b[134][abc]\b|\bSystem [1-4]\b/.test((await page.locator(".point-picker").allTextContents()).join(" ")));
      for (const point of points) {
        assert.equal(point.x, expected[point.id][kind === "qubits" ? 5 : 0]);
        assert.equal(point.y, expected[point.id][kind === "qubits" ? 6 : 1]);
        assert.ok(Number.isFinite(point.cx) && Number.isFinite(point.cy));
        const x = Number(axes.left) + Number(BigInt(point.x) * 1000000n / BigInt(axes.xMax)) / 1000000 * (axes.width - Number(axes.left) - Number(axes.right));
        const y = Number(axes.top) + (1 - Number(BigInt(point.y) * 1000000n / BigInt(axes.yMax)) / 1000000) * (axes.height - Number(axes.top) - Number(axes.bottom));
        assert.ok(Math.abs(point.cx - x) < 0.00001 && Math.abs(point.cy - y) < 0.00001, "Scatter coordinates must derive from the exact source values.");
      }
      const point = page.locator(`[data-scatter="${kind}"] [data-point="4c"]`);
      await point.focus();
      await point.press("Enter");
      assert.match(await text(page, `#point-detail-${kind}`), /IQPE N2/);
      assert.equal(await text(page, `#point-detail-${kind} [data-exact-x]`), kind === "qubits" ? "9" : "6,232");
    }
    assert.match(await text(page, "main"), /w\/o move/);
    await page.locator("#point-detail-operations a").click();
    assert.equal(await page.inputValue("#candidate-select"), "4c");
    await page.selectOption("#overview-mode", "global");
    assert.equal(await page.locator("[data-global-chart] g[data-global-id]").count(), 8);
    assert.equal(await page.locator("[data-global-chart] path[data-series]").count(), 0, "No invented trend from one date.");
    const colors = await page.locator("[data-global-chart] g[data-global-id]").evaluateAll(points => points.map(point => point.getAttribute("stroke")));
    assert.equal(new Set(colors).size, 8);
    assert.ok(!/\b[134][abc]\b|\bSystem [1-4]\b/.test(await text(page, ".series-legend")));
    for (const [metric, index] of [["logicalOps", 0], ["logicalQubits", 5]]) {
      await page.selectOption("#global-metric", metric);
      const points = await page.locator("[data-global-chart] g[data-global-id]").evaluateAll(points => points.map(point => ({ id: point.dataset.globalId, value: point.dataset.value, cy: Number(point.dataset.y) })));
      const axes = await page.locator("[data-global-chart]").evaluate(svg => ({ ...svg.dataset, height: svg.viewBox.baseVal.height }));
      assert.equal(points.length, 8);
      for (const point of points) {
        assert.equal(point.value, expected[point.id][index]);
        const expectedY = Number(axes.top) + (1 - Number(BigInt(point.value) * 1000000n / BigInt(axes.maximum)) / 1000000) * (axes.height - Number(axes.top) - Number(axes.bottom));
        assert.ok(Math.abs(point.cy - expectedY) < 0.00001);
      }
      await page.locator(`[data-global-chart] [data-global-id="3a"]`).focus();
      assert.match(await text(page, "#global-point-detail"), /IQPE extended Hubbard Ethylene/);
    }
    await page.locator('[data-global-visible="4c"]').uncheck();
    assert.equal(await page.locator('[data-global-chart] [data-global-id="4c"]').count(), 0);
    await page.locator('[data-action="show-all-series"]').click();
    assert.equal(await page.locator("[data-global-chart] g[data-global-id]").count(), 8);
    const globalUrl = page.url();
    const fresh = await open(globalUrl);
    assert.equal(await fresh.page.inputValue("#overview-mode"), "global");
    assert.equal(await fresh.page.inputValue("#global-metric"), "logicalQubits");
    await fresh.context.close();
  } finally { await context.close(); }
}

async function numericalFixtures() {
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => {
      Object.defineProperty(window, "RESOURCE_DATA", { configurable: true, set(value) {
        const data = structuredClone(value);
        for (const item of data.workloads) item.snapshots[0].asOf = null;
        const base = data.workloads[0].snapshots[0];
        const first = structuredClone(base);
        Object.assign(first, { id: "test-first", asOf: "2026-09-01", local: true });
        first.metrics.logicalOps = "0";
        first.metrics.logicalQubits = "0";
        const second = structuredClone(first);
        Object.assign(second, { id: "test-second", asOf: "2026-09-08" });
        second.metrics.logicalOps = "900719925474099312345678901234567890";
        second.context.targetPhysicalQubits = "0";
        second.context.targetWindow = "Next sprint";
        second.context.targetConfig = second.config;
        data.workloads[0].snapshots.push(first, second);
        data.workloads[1].snapshots[0].metrics.logicalQubits = null;
        Object.defineProperty(window, "RESOURCE_DATA", { value: data, configurable: true });
      } });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.stack));
    await page.goto(urlFor("overview"));
    assert.match(await page.locator(".delta").first().innerText(), /previous count is zero/);
    await details(page);
    assert.match(await text(page, ".goal-line"), /Percentage unavailable for a zero target/);
    assert.equal(await page.locator(".overhead strong").nth(1).innerText(), "Not available");
    await page.selectOption("#overview-mode", "global");
    const raw = await page.locator('[data-global-chart] [data-snapshot="test-second"]').getAttribute("data-value");
    assert.equal(raw, "900719925474099312345678901234567890");
    assert.equal(await page.locator("[data-series='1a']").count(), 1);
    assert.equal(await page.locator("[data-global-chart] g[data-global-id]").count(), 2, "Undated candidates must not acquire fake historical dates.");
    const invalid = await page.locator("[data-global-chart] [data-x]").evaluateAll(points => points.some(point => !Number.isFinite(Number(point.dataset.x)) || !Number.isFinite(Number(point.dataset.y))));
    assert.equal(invalid, false);
    await nav(page, "compare");
    assert.equal(await page.locator("[data-scatter='qubits'] g[data-point]").count(), 7);
  } finally { await context.close(); }
}

async function responsive() {
  for (const width of [320, 390, 768, 1440]) {
    const { context, page } = await open(urlFor("overview"), { viewport: { width, height: width < 600 ? 844 : 900 } });
    try {
      for (const view of ["overview", "global", "compare", "roadmap"]) {
        if (view === "global") await page.selectOption("#overview-mode", "global");
        if (view === "compare") await nav(page, "compare");
        if (view === "roadmap") { await page.goto(urlFor("roadmap", { mode: "engineering" })); }
        const layout = await page.evaluate(() => ({
          width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
          small: [...document.querySelectorAll(".estimate-meta,.chart-caption,.stage-title,.stage-status,.series-legend label,.field-hint,.comparison-caption,.roadmap-color-options label")]
            .filter(element => element.getClientRects().length && parseFloat(getComputedStyle(element).fontSize) < 12).map(element => element.className)
        }));
        assert.ok(layout.scrollWidth <= width + 1, `${view} overflow at ${width}px: ${layout.scrollWidth}`);
        assert.deepEqual(layout.small, []);
        const clipped = await page.locator("svg.chart,svg.scatter").evaluateAll(charts => charts.flatMap(svg => [...svg.querySelectorAll("text")].filter(label => {
          const box = label.getBBox();
          const size = parseFloat(getComputedStyle(label).fontSize) * svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
          return box.x < -1 || box.x + box.width > svg.viewBox.baseVal.width + 1 || size < 12;
        }).map(label => label.textContent)));
        assert.deepEqual(clipped, [], `${view} chart labels must not be clipped or shrunk at ${width}px`);
        layouts.push({ view, ...layout });
        if (artifacts && process.argv.includes("--visual") && [390, 1440].includes(width)) {
          await fs.mkdir(artifacts, { recursive: true });
          await page.evaluate(() => scrollTo(0, 0));
          await page.screenshot({ path: path.join(artifacts, `${width}-${view}.png`), fullPage: true });
        }
      }
    } finally { await context.close(); }
  }
}

async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function startServer(database, port) {
  const child = spawn(process.env.PYTHON || "python", [path.join(directory, "server.py"), "--database", database, "--port", String(port)], { windowsHide: true });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Database process exited: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`);
      await response.arrayBuffer();
      if (response.ok) return { child, origin: `http://127.0.0.1:${port}/` };
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`Database did not start: ${output} ${lastError?.message || ""}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill();
  await exited;
}

async function roadmapColorWorkflow(page, origin) {
  const stateFromServer = () => page.request.get(`${origin}api/state`).then(response => response.json());
  const colorControl = color => page.locator(`[data-roadmap="color"][value="${color}"]`);
  const saveColor = async () => {
    const response = page.waitForResponse(response => response.url().endsWith("/api/save") && response.request().method() === "POST");
    await page.locator("#save-roadmap").click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.querySelector("main").hasAttribute("aria-busy") && document.getElementById("roadmap-stage")?.value === "specification");
  };
  const savedAssessment = (await stateFromServer()).data.roadmap.find(stage => stage.id === "correctness");
  assert.equal(savedAssessment.color, undefined, "Existing records need no color migration.");
  await editFrom(page, "roadmap");
  await page.selectOption("#roadmap-stage", "correctness");
  assert.ok(await colorControl("default").isChecked());
  assert.match(await text(page, "#roadmap-color-preview"), /Red \(source default\).*In progress/);
  const beforeCancel = (await stateFromServer()).revision;
  await colorControl("green").check();
  await colorControl("green").press("ArrowRight");
  assert.ok(await colorControl("amber").isChecked(), "The labeled palette supports keyboard selection.");
  assert.match(await text(page, "#roadmap-color-preview"), /Amber.*In progress/);
  assert.equal(await page.inputValue('[data-roadmap="status"]'), "In progress");
  await nav(page, "overview");
  await page.locator("#discard-dialog").waitFor({ state: "visible" });
  await page.locator("#keep-editing").click();
  assert.ok(await colorControl("amber").isChecked());
  await page.locator('[data-action="cancel-roadmap"]').click();
  await page.locator("#discard-edits").click();
  assert.equal((await stateFromServer()).revision, beforeCancel);
  await page.selectOption("#roadmap-stage", "correctness");
  assert.ok(await colorControl("default").isChecked());

  await colorControl("green").evaluate(input => {
    input.value = "purple";
    input.checked = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#save-roadmap").click();
  assert.match(await text(page, "#roadmap-errors"), /listed stage color/);
  assert.equal((await stateFromServer()).revision, beforeCancel);
  await page.locator('[data-roadmap="color"][value="purple"]').evaluate(input => { input.value = "green"; });
  await colorControl("red").check();
  await colorControl("green").check();
  await saveColor();
  const green = (await stateFromServer()).data.roadmap.find(stage => stage.id === "correctness");
  assert.equal(green.color, "green");
  assert.equal(green.status, savedAssessment.status);
  assert.equal(green.note, savedAssessment.note);
  assert.equal(green.revisions.at(-1).color, undefined, "Prior record without color remains intact.");
  const raw = await page.request.get(`${origin}api/records`).then(response => response.json());
  assert.equal(raw.records.filter(record => record.kind === "roadmap").at(-1).raw.color, "green");
  await page.reload();
  await page.locator("#roadmap-stage").waitFor();
  await page.selectOption("#roadmap-stage", "correctness");
  assert.ok(await colorControl("green").isChecked());
  await nav(page, "overview");
  for (const overviewMode of ["candidate", "global"]) {
    await page.selectOption("#overview-mode", overviewMode);
    assert.equal(await page.locator('[data-roadmap-stage="correctness"]').getAttribute("data-color"), "green");
    assert.equal(await text(page, '[data-roadmap-stage="correctness"] .stage-status'), "In progress");
  }
  assert.equal(await page.evaluate(() => window.RESOURCE_DATA.roadmap.find(stage => stage.id === "correctness").color), undefined, "Local edits must not modify the published seed.");

  await editFrom(page, "roadmap");
  await page.selectOption("#roadmap-stage", "correctness");
  await colorControl("default").check();
  await saveColor();
  const restored = (await stateFromServer()).data.roadmap.find(stage => stage.id === "correctness");
  assert.equal(restored.color, "default");
  assert.equal(restored.revisions.at(-1).color, "green");
  assert.equal(restored.status, savedAssessment.status);
  await nav(page, "overview");
  assert.equal(await page.locator('[data-roadmap-stage="correctness"]').getAttribute("data-color"), "red");
  await page.selectOption("#overview-mode", "candidate");
  assert.equal(await page.locator('[data-roadmap-stage="correctness"]').getAttribute("data-color"), "red");

  const concurrent = await open(urlFor("roadmap", { mode: "engineering" }, origin));
  try {
    await concurrent.page.selectOption("#roadmap-stage", "correctness");
    await concurrent.page.locator('[data-roadmap="color"][value="blue"]').check();
    await editFrom(page, "roadmap");
    await page.selectOption("#roadmap-stage", "correctness");
    await colorControl("amber").check();
    await saveColor();
    await concurrent.page.locator("#save-roadmap").click();
    await concurrent.page.locator(".inline-message.error").waitFor();
    assert.match(await text(concurrent.page, ".inline-message.error"), /Save not confirmed.*State changed/);
    assert.ok(await concurrent.page.locator('[data-roadmap="color"][value="blue"]').isChecked(), "Stale color draft is retained for recovery.");
    const current = await stateFromServer();
    assert.equal(current.data.roadmap.find(stage => stage.id === "correctness").color, "amber");
  } finally { await concurrent.context.close(); }

  if (artifacts && process.argv.includes("--visual")) {
    await page.selectOption("#roadmap-stage", "correctness");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(artifacts, `${width}-roadmap-editor.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await nav(page, "overview");
}

async function privateWorkspace() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "resource-estimates-check-"));
  const database = path.join(temporary, "inputs.sqlite");
  const port = await freePort();
  let service = await startServer(database, port);
  const { context, page } = await open(service.origin);
  try {
    assert.equal(await page.locator("body").getAttribute("data-storage"), "local");
    assert.equal(await text(page, "#storage-caption"), "Local editing workspace");
    assert.equal(await page.locator("[data-mode],.demo-switch").count(), 0);
    assert.deepEqual(await page.locator(".main-nav a").allTextContents(), [...readingTabs, "Raw data"]);
    assert.ok(await page.locator('[data-edit-route="edit"]').isVisible());
    assert.ok(await page.locator('[data-edit-route="roadmap"]').isVisible());
    await editFrom(page);
    assert.deepEqual(await page.locator(".main-nav a").allTextContents(), [...readingTabs, "Raw data"]);
    await page.fill("#estimate-date", "2026-09-23");
    await page.fill("#change-note", "Test-only saved estimate; not published.");
    await countField(page, "logicalOps").fill("1.5");
    await page.locator("#save-updates").click();
    assert.match(await text(page, "#editor-errors"), /Nothing was saved/);
    let stored = await page.request.get(`${service.origin}api/state`).then(response => response.json());
    assert.equal(stored.revision, 0);
    await countField(page, "logicalOps").fill("6.4e2");
    await countField(page, "physicalOps").fill("325,000");
    await countField(page, "logicalQubits").fill("10");
    await countField(page, "physicalQubits").fill("230");
    await page.locator("#editor-context > summary").click();
    await contextField(page, "owner").fill("Test engineer");
    await contextField(page, "maturity").selectOption("Reviewed");
    await page.locator("#save-updates").click();
    await page.waitForURL(/#overview$/);
    assert.deepEqual(await page.locator("[data-metric]").allTextContents(), ["640", "10"]);
    await page.reload();
    await page.locator('[data-metric="logicalOps"]').waitFor();
    assert.deepEqual(await page.locator("[data-metric]").allTextContents(), ["640", "10"]);
    const localUrl = page.url();
    await page.locator("#share-action").click();
    const publicUrl = await page.inputValue("#share-url");
    assert.equal(new URL(publicUrl).searchParams.get("snapshot"), "source-1a-v2");
    assert.ok(!publicUrl.includes("Test") && !publicUrl.includes("325000"));
    assert.match(await text(page, "#share-copy"), /Locally saved changes are not available/);
    await page.locator('[data-action="close-share"]').click();
    await nav(page, "compare");
    assert.equal(await page.locator("[data-scatter='operations'] [data-point='1a']").getAttribute("data-x"), "640");
    await nav(page, "records");
    assert.match(await text(page, ".raw-records"), /6.4e2|estimates/);
    const rawResponse = await page.request.get(`${service.origin}api/records`).then(response => response.json());
    const submission = rawResponse.records.find(record => record.kind === "estimates");
    assert.equal(submission.raw.rows[0].metrics.logicalOps, "6.4e2");
    assert.equal(submission.raw.rows[0].metrics.physicalOps, "325,000");
    assert.equal((await page.request.get(`${service.origin}api/database`)).status(), 200);
    assert.equal((await page.request.get(`${service.origin}api/export`)).status(), 200);
    await editFrom(page);
    await page.fill("#estimate-date", "2026-09-30");
    await page.fill("#change-note", "Test-only second dated estimate.");
    await countField(page, "logicalOps").fill("1280");
    await page.locator("#editor-context > summary").click();
    await contextField(page, "targetPhysicalQubits").fill("200");
    await contextField(page, "targetWindow").fill("Next sprint");
    await contextField(page, "targetConfig").fill("clifford-rounded-no-move");
    await page.locator("#save-updates").click();
    await page.waitForURL(/#overview$/);
    assert.match(await page.locator(".delta").first().innerText(), /100% higher/);
    await details(page);
    assert.match(await text(page, ".goal-line"), /200 target.*Next sprint.*30 above target; 15%/);
    await page.selectOption("#overview-mode", "global");
    assert.equal(await page.locator("[data-series='1a']").count(), 1);
    await editFrom(page, "write");
    for (let i = 1; i <= 4; i++) {
      await page.locator('[data-action="new-written"]').click();
      await field(page, "title").fill(`Test briefing ${i}`);
      await field(page, "body").fill("Test-only leadership context.");
      await field(page, "date").fill("2026-09-23");
      await field(page, "owner").fill("Test engineer");
      await page.locator("#written-form button[type='submit']").click();
      await page.locator("#written-form").waitFor({ state: "detached" });
    }
    assert.ok(await page.locator('[data-action="new-written"]').isDisabled());
    const lastId = await page.locator(".writing-list > li").last().getAttribute("data-written-id");
    await page.locator(`[data-written-id="${lastId}"] [data-direction="-1"]`).click();
    await page.waitForFunction(id => document.querySelectorAll(".writing-list > li")[2]?.dataset.writtenId === id, lastId);
    await page.locator(`[data-written-id="${lastId}"] [data-action="archive-written"]`).click();
    await page.locator(`[data-written-id="${lastId}"]`).waitFor({ state: "detached" });
    await page.locator(".written-history summary").click();
    await page.locator(`[data-action="restore-written"][data-id="${lastId}"]`).click();
    await page.locator(`[data-written-id="${lastId}"]`).waitFor();
    await page.locator(`[data-written-id="${lastId}"] [data-action="edit-written"]`).click();
    await field(page, "title").fill("Discard this uncommitted note");
    await page.evaluate(() => history.back());
    await page.locator("#discard-dialog").waitFor({ state: "visible" });
    await page.locator("#keep-editing").click();
    assert.equal(await field(page, "title").inputValue(), "Discard this uncommitted note");
    await page.locator('[data-action="cancel-written"]').click();
    await page.locator("#discard-edits").click();
    await page.locator('[data-action="writing-panel"][data-kind="milestones"]').click();
    await page.locator('[data-action="new-written"]').click();
    assert.equal(await page.locator('#written-form input[type="date"]').count(), 0);
    await field(page, "title").fill("Test sprint milestone");
    await field(page, "outcome").fill("Test-only resource review.");
    await field(page, "owner").fill("Test engineer");
    await field(page, "window").fill("Sprint 3-4");
    await field(page, "targetCandidate").selectOption("1a");
    assert.match(await text(page, "#linked-target-preview"), /200 physical-qubit objective.*Next sprint/);
    await page.locator("#written-form button[type='submit']").click();
    await page.locator("#written-form").waitFor({ state: "detached" });
    await nav(page, "updates");
    assert.equal(await page.locator("[data-update-id]").count(), 4);
    assert.match(await text(page, ".milestones"), /Next sprint.*Test sprint milestone/);
    await editFrom(page, "roadmap");
    await page.selectOption("#roadmap-stage", "correctness");
    await page.selectOption('[data-roadmap="status"]', "In progress");
    await page.fill('[data-roadmap="owner"]', "Test engineer");
    await page.fill('[data-roadmap="note"]', "Test-only correctness assessment.");
    await page.fill('[data-roadmap="window"]', "Next sprint");
    await page.locator("#save-roadmap").click();
    await page.locator(".inline-message.success").filter({ hasText: "Roadmap assessment and color saved" }).waitFor();
    await nav(page, "overview");
    assert.match(await text(page, "[data-roadmap-stage='correctness']"), /In progress/);
    await roadmapColorWorkflow(page, service.origin);
    const firstWindow = await open(urlFor("edit", {}, service.origin));
    await firstWindow.page.fill("#estimate-date", "2026-10-01");
    await firstWindow.page.fill("#change-note", "Stale window must not overwrite.");
    await countField(firstWindow.page, "logicalOps").fill("1300");
    await editFrom(page);
    await page.fill("#estimate-date", "2026-10-01");
    await page.fill("#change-note", "Concurrent current save.");
    await countField(page, "logicalOps").fill("1290");
    await page.locator("#save-updates").click();
    await page.waitForURL(/#overview$/);
    await firstWindow.page.locator("#save-updates").click();
    await firstWindow.page.locator(".inline-message.error").waitFor();
    assert.match(await text(firstWindow.page, ".inline-message.error"), /Save not confirmed/);
    assert.equal(await countField(firstWindow.page, "logicalOps").inputValue(), "1,300");
    await firstWindow.context.close();
    stored = await page.request.get(`${service.origin}api/state`).then(response => response.json());
    const revision = stored.revision;
    await context.close();
    await stopServer(service.child);
    service = await startServer(database, port);
    const response = await fetch(`${service.origin}api/state`).then(response => response.json());
    assert.equal(response.revision, revision);
    assert.equal(response.data.workloads[0].snapshots.at(-1).metrics.logicalOps, "1290");
    assert.ok(response.data.workloads[0].snapshots.some(record => record.id === "source-1a-v2"));
    assert.equal(response.data.roadmap.find(stage => stage.id === "correctness").color, "amber", "Color survives service restart.");
    assert.equal(response.data.roadmap.find(stage => stage.id === "correctness").status, "In progress");
    assert.ok(localUrl.includes("saved-"));
  } finally {
    await context.close();
    await stopServer(service.child);
    await fs.rm(temporary, { recursive: true });
  }
}

(async () => {
  browser = await chromium.launch(process.env.EDGE_PATH ? { executablePath: process.env.EDGE_PATH, headless: true } : { channel: "msedge", headless: true });
  try {
    await check("all supplied names/counts, confirmed source date, assumptions and read-only public boundary", suppliedData);
    await check("candidate/system links, published sharing, invalid-state recovery and browser history", links);
    await check("two exact scatter plots and distinguishable all-candidate global metric chart", plotMapping);
    if (!process.env.DASHBOARD_URL) await check("zero/huge/missing counts and honest dated versus undated history", numericalFixtures);
    await check("desktop/tablet/mobile layout and readable labels", responsive);
    if (process.argv.includes("--private")) await check("durable private raw inputs, exact saves, conflicts, history, sprint editors and roadmap", privateWorkspace);
    assert.deepEqual(errors, [], "No browser runtime errors.");
    if (artifacts) {
      await fs.mkdir(artifacts, { recursive: true });
      await fs.writeFile(path.join(artifacts, "checks.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), results, errors, layouts }, null, 2));
    }
    console.log(`${results.length} check groups passed.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
