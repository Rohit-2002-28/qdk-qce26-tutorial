const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const base = process.env.DEMO_URL || pathToFileURL(path.resolve(__dirname, "..", "index.html")).href;
const artifacts = process.env.REVIEW_ARTIFACTS;
const results = [];
const pageErrors = [];
let browser;

const route = (name, params = {}) => {
  const url = new URL(base);
  url.search = new URLSearchParams(params).toString();
  url.hash = name;
  return url.href;
};
const text = async (page, selector) => (await page.locator(selector).innerText()).trim().replace(/\s+/g, " ");
const nav = (page, name) => page.locator(`.main-nav [data-route="${name}"]`).click();
const mode = (page, name) => page.locator(`[data-mode="${name}"]`).click();
const count = (page, key, value, id = "App 1a") => page.locator(`[data-workload-id="${id}"][data-field="${key}"]`).fill(value);
const written = (page, key) => page.locator(`[data-written="${key}"]`);
const contextField = (page, key) => page.locator(`[data-context="${key}"]`);

async function createPage(url = route("overview"), options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage();
  page.on("pageerror", error => pageErrors.push(error.stack));
  await page.goto(url);
  await page.locator("h1").waitFor();
  return { page, context };
}

async function check(name, fn) {
  await fn();
  results.push(name);
  console.log(`PASS ${name}`);
}

async function assertPlots(page) {
  const data = await page.evaluate(() => {
    const expected = window.RESOURCE_DEMO.workloads.map(item => {
      const latest = [...item.snapshots].sort((a, b) => a.asOf.localeCompare(b.asOf) || a.revision - b.revision).at(-1);
      return { id: item.id, metrics: latest.metrics };
    });
    const plots = [...document.querySelectorAll("[data-scatter]")].map(svg => ({
      kind: svg.dataset.scatter, width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height,
      ...Object.fromEntries(["xMax", "yMax", "left", "right", "top", "bottom"].map(key => [key, svg.dataset[key]])),
      points: [...svg.querySelectorAll("[data-point]")].map(point => ({
        id: point.dataset.point, x: point.dataset.x, y: point.dataset.y,
        cx: Number(point.dataset.cx), cy: Number(point.dataset.cy)
      }))
    }));
    return { expected, plots };
  });
  assert.equal(data.plots.length, 2);
  for (const plot of data.plots) {
    assert.equal(plot.points.length, 8);
    for (const point of plot.points) {
      const sample = data.expected.find(row => row.id === point.id);
      const xKey = plot.kind === "qubits" ? "logicalQubits" : "logicalOps";
      const yKey = plot.kind === "qubits" ? "physicalQubits" : "physicalOps";
      assert.equal(point.x, sample.metrics[xKey]);
      assert.equal(point.y, sample.metrics[yKey]);
      const x = Number(plot.left) + Number(BigInt(point.x) * 1000000n / BigInt(plot.xMax)) / 1000000 * (plot.width - Number(plot.left) - Number(plot.right));
      const y = Number(plot.top) + (1 - Number(BigInt(point.y) * 1000000n / BigInt(plot.yMax)) / 1000000) * (plot.height - Number(plot.top) - Number(plot.bottom));
      assert.ok(Math.abs(point.cx - x) < 0.00001, `${point.id}: x mapping`);
      assert.ok(Math.abs(point.cy - y) < 0.00001, `${point.id}: y mapping`);
    }
  }
}

async function routing() {
  const { page, context } = await createPage();
  try {
    assert.equal(await text(page, "[data-metric='logicalOps']"), "120M");
    assert.equal(await text(page, "[data-metric='logicalQubits']"), "240");
    assert.match(await text(page, ".goal-line"), /360K physical qubits.*340K target.*20K above target; 5.9%/);
    assert.match(await text(page, ".assumption-notice"), /Same-version comparison: demo-v2/);
    assert.equal(await page.locator(".main-nav [data-route='edit']").count(), 0);
    assert.ok(await page.locator(".ledger").getByText("Update overdue").isVisible());
    const contextY = (await page.locator(".decision-context").boundingBox()).y;
    assert.ok(contextY < 900, "Goal context must be above the desktop fold.");
    assert.ok(contextY < (await page.locator(".trend-grid").boundingBox()).y);
    for (const metric of await page.locator("[data-metric]").all()) {
      assert.ok((await metric.boundingBox()).y < contextY, "Both logical headlines precede the goal and large charts.");
    }
    const arrow = await page.locator("#system-filter").evaluate(element => {
      const css = getComputedStyle(element);
      return { padding: css.paddingRight, size: css.backgroundSize, position: css.backgroundPosition };
    });
    assert.deepEqual(arrow, { padding: "36px", size: "14px 14px", position: "calc(100% - 12px) 50%" });
    await page.selectOption("#system-filter", "2");
    await page.locator(".ledger .workload-button", { hasText: "App 2c" }).click();
    await page.selectOption("#snapshot-select", "App 2c-2026-09-15-0");
    const selectedUrl = page.url();
    const query = new URL(selectedUrl).searchParams;
    assert.equal(query.get("candidate"), "App 2c");
    assert.equal(query.get("system"), "2");
    assert.equal(query.get("snapshot"), "App 2c-2026-09-15-0");
    assert.equal(query.get("config"), "demo-v1");
    const fresh = await createPage(selectedUrl);
    assert.match(await text(fresh.page, "#selected-title"), /App 2c/);
    assert.equal(await fresh.page.inputValue("#system-filter"), "2");
    assert.equal(await fresh.page.inputValue("#snapshot-select"), "App 2c-2026-09-15-0");
    assert.equal(await text(fresh.page, "[data-metric='logicalOps']"), "147M");
    await fresh.page.reload();
    assert.equal(await fresh.page.inputValue("#snapshot-select"), "App 2c-2026-09-15-0");
    await fresh.context.close();
    await nav(page, "compare");
    assert.equal(new URL(page.url()).searchParams.get("snapshot"), query.get("snapshot"));
    await page.goBack();
    assert.equal(page.url(), selectedUrl);
    await page.goBack();
    assert.equal(await page.inputValue("#snapshot-select"), "App 2c-2026-09-22-0");
    await page.goForward();
    assert.equal(await page.inputValue("#snapshot-select"), "App 2c-2026-09-15-0");
    await page.locator("#share-action").click();
    assert.equal(await page.inputValue("#share-url"), selectedUrl);
    await page.locator("[data-action='close-share']").click();
    const modifierResult = await page.locator(".main-nav [data-route='compare']").evaluate(link => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
      link.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(modifierResult, false, "Modifier-click must retain native behavior.");
    const targetHref = await page.locator(".main-nav [data-route='compare']").getAttribute("href");
    assert.equal(new URL(targetHref).searchParams.get("candidate"), "App 2c");
    for (const [url, expected] of [
      [route("unknown"), /tab "unknown"/],
      [route("overview", { candidate: "Unknown" }), /candidate "Unknown"/],
      [route("overview", { candidate: "App 2c", system: "1" }), /does not belong/],
      [route("overview", { candidate: "App 2c", snapshot: "missing-snapshot" }), /snapshot.*unavailable/],
      [route("overview", { snapshot: "" }), /empty view parameter/],
      [route("overview", { config: "not-this-version" }), /not the requested configuration/]
    ]) {
      const invalid = await createPage(url);
      assert.match(await text(invalid.page, ".unavailable-view"), expected);
      assert.equal(await invalid.page.locator("[data-metric]").count(), 0);
      await invalid.page.locator(".unavailable-view a").click();
      assert.equal(await text(invalid.page, "h1"), "Resource overview");
      await invalid.context.close();
    }
    for (const name of ["edit", "guide"]) {
      const legacy = await createPage(route(name));
      assert.equal(await legacy.page.locator("[data-mode='engineering']").getAttribute("aria-current"), "page");
      await legacy.context.close();
    }
  } finally { await context.close(); }
}

async function plots() {
  const { page, context } = await createPage(route("compare"));
  try {
    await assertPlots(page);
    const point = page.locator("svg[data-scatter='qubits'] [data-point='App 2c']");
    await point.focus();
    assert.match(await text(page, "#point-detail-qubits"), /App 2c/);
    await point.press("Enter");
    assert.equal(new URL(page.url()).searchParams.get("candidate"), "App 2c");
    const fresh = await createPage(page.url());
    assert.match(await text(fresh.page, "#point-detail-qubits"), /App 2c/);
    await fresh.context.close();
    await page.locator(".point-picker [data-plot='operations'][data-point='App 1a']").click();
    assert.equal(await text(page, "#point-detail-operations [data-exact-x]"), "120,000,000");
    assert.equal(await text(page, "#point-detail-operations [data-exact-y]"), "144,000,000,000");
    await page.locator("#point-detail-operations a").click();
    assert.match(await text(page, "#selected-title"), /App 1a/);
    assert.equal(await page.inputValue("#snapshot-select"), "App 1a-2026-09-22-0");
  } finally { await context.close(); }
}

async function estimateSaves() {
  const { page, context } = await createPage(route("edit"));
  try {
    const original = await page.inputValue('[data-workload-id="App 1a"][data-field="physicalOps"]');
    await page.locator('[data-workload-id="App 1a"][data-field="logicalOps"]').evaluate(input => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "1.14e8\t1.425e11\n1.8e8\t2.7e11");
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    });
    assert.equal(await page.inputValue('[data-workload-id="App 1a"][data-field="logicalOps"]'), "114,000,000");
    assert.equal(await page.inputValue('[data-workload-id="App 1a"][data-field="physicalOps"]'), "142,500,000,000");
    assert.ok(await page.locator('[data-row-check="App 1b"]').isChecked());
    await count(page, "logicalOps", "114000000");
    await count(page, "physicalOps", "1.5");
    await page.fill("#change-note", "Synthetic revised schedule for this test.");
    await page.locator("#save-updates").click();
    assert.match(await text(page, "#editor-errors"), /Nothing was saved/);
    await count(page, "physicalOps", original);
    await page.locator('[data-workload-id="App 1a"][data-field="logicalOps"]').evaluate(input => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "9\tinvalid");
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    });
    assert.equal(await page.inputValue('[data-workload-id="App 1a"][data-field="logicalOps"]'), "114,000,000");
    assert.match(await text(page, "#editor-errors"), /Paste rejected; no cells changed/);
    await count(page, "physicalOps", "142500000000");
    await count(page, "logicalQubits", "230");
    await count(page, "physicalQubits", "345000");
    await page.locator("#editor-context > summary").click();
    await contextField(page, "maturity").selectOption("Provisional");
    await page.locator("#save-updates").click();
    assert.equal(await text(page, "[data-metric='logicalOps']"), "114M");
    assert.equal(await text(page, "[data-metric='logicalQubits']"), "230");
    assert.match(await text(page, ".goal-line"), /345K physical qubits.*5K above target; 1.5%/);
    assert.match(await text(page, ".estimate-status"), /Provisional.*in-tab/);
    assert.equal(await page.locator("[data-briefing-id]").count(), 3, "Saving counts must not evict briefing bullets.");
    const localUrl = page.url();
    assert.match(new URL(localUrl).searchParams.get("snapshot"), /^local-/);
    await page.locator("#share-action").click();
    const publishedUrl = await page.inputValue("#share-url");
    assert.match(await text(page, "#share-copy"), /in-tab edits that another visitor cannot load/);
    assert.equal(new URL(publishedUrl).searchParams.get("snapshot"), "App 1a-2026-09-22-0");
    assert.ok(!publishedUrl.includes("Synthetic") && !publishedUrl.includes("345000") && !publishedUrl.includes("Demo+engineer"));
    await page.locator("[data-action='close-share']").click();
    const unavailable = await createPage(localUrl);
    assert.match(await text(unavailable.page, ".unavailable-view"), /In-tab edits are not published server data/);
    await unavailable.context.close();
    const publishedPage = await createPage(publishedUrl);
    assert.equal(await text(publishedPage.page, "[data-metric='logicalOps']"), "120M");
    await publishedPage.context.close();
    await nav(page, "compare");
    assert.equal(await page.locator("[data-scatter='qubits'] [data-point='App 1a']").getAttribute("data-x"), "230");
    assert.equal(await page.locator("[data-scatter='qubits'] [data-point='App 1a']").getAttribute("data-y"), "345000");
    assert.equal(await page.locator("[data-scatter='operations'] [data-point='App 1a']").getAttribute("data-x"), "114000000");
    assert.equal(await page.locator("[data-scatter='operations'] [data-point='App 1a']").getAttribute("data-y"), "142500000000");
    await mode(page, "engineering");
    await page.fill("#estimate-date", "2026-09-01");
    await count(page, "logicalOps", "115000000");
    await page.fill("#change-note", "Synthetic correction to an earlier dated snapshot.");
    await page.locator("#save-updates").click();
    assert.equal(await text(page, "[data-metric='logicalOps']"), "114M", "Backdating must not replace the latest dated estimate.");
    assert.equal(await page.locator("#snapshot-select option").count(), 8);
    await page.selectOption("#snapshot-select", "App 1a-2026-09-22-0");
    assert.equal(await text(page, "[data-metric='logicalOps']"), "120M", "Original revision remains available.");
    await mode(page, "engineering");
    await page.locator("#editor-context > summary").click();
    await contextField(page, "targetPhysicalQubits").fill("330000");
    await contextField(page, "targetDate").fill("2026-10-22");
    await page.fill("#change-note", "Synthetic shared target revision.");
    await page.locator("#save-updates").click();
    assert.match(await text(page, ".goal-line"), /330K target by 22 Oct 2026.*15K above target; 4.5%/);
    await nav(page, "updates");
    assert.match(await text(page, '[data-linked-target="App 1a"]'), /330K target by 22 Oct 2026.*15K above target/);
    await mode(page, "engineering");
    await count(page, "logicalOps", "0");
    await count(page, "logicalQubits", "0");
    await page.locator("#editor-context > summary").click();
    await contextField(page, "targetPhysicalQubits").fill("0");
    await page.fill("#change-note", "Synthetic zero-denominator example.");
    await page.locator("#save-updates").click();
    assert.match(await text(page, ".goal-line"), /Percentage unavailable for a zero target/);
    assert.deepEqual(await page.locator(".overhead strong").allTextContents(), ["Not available", "Not available"]);
    await mode(page, "engineering");
    await page.locator("#editor-context > summary").click();
    await contextField(page, "config").fill("demo-new-basis");
    await page.fill("#change-note", "Synthetic new assumptions basis.");
    await page.locator("#save-updates").click();
    assert.match(await text(page, ".goal-line"), /Not comparable/);
    assert.equal(await page.locator(".delta").getByText("No comparable earlier estimate").count(), 2);
    await nav(page, "compare");
    assert.equal(await page.locator("[data-scatter='qubits'] [data-point='App 1a']").getAttribute("data-x"), "0");
  } finally { await context.close(); }
}

async function writtenWorkflow() {
  const { page, context } = await createPage(route("write"));
  try {
    await page.locator("[data-action='new-written']").click();
    assert.match(await written(page, "body").inputValue(), /revised circuit schedule/);
    await page.locator("#written-form button[type='submit']").click();
    assert.match(await text(page, "#written-errors"), /Short headline is required/);
    assert.equal(await page.locator(".writing-list > li").count(), 3);
    await written(page, "title").fill("Synthetic leadership request");
    await written(page, "body").fill("A fictional review note shared by both leadership views.");
    await page.locator(".optional-request summary").click();
    await written(page, "requestKind").selectOption("Decision");
    await written(page, "request").fill("Choose the fictional review scope.");
    await page.locator("#written-form button[type='submit']").click();
    assert.match(await text(page, "#written-errors"), /both its text and its owner/);
    await written(page, "requestOwner").fill("Demo lead A");
    await written(page, "requestDue").fill("2026-09-30");
    await mode(page, "leadership");
    assert.ok(await page.locator("#discard-dialog").isVisible());
    await page.locator("#keep-editing").click();
    assert.equal(await written(page, "title").inputValue(), "Synthetic leadership request");
    await page.locator("#written-form button[type='submit']").click();
    assert.equal(await page.locator(".writing-list > li").count(), 4);
    assert.ok(await page.locator("[data-action='new-written']").isDisabled());
    const newId = await page.locator(".writing-list > li").last().getAttribute("data-written-id");
    for (let i = 0; i < 3; i++) await page.locator(`[data-written-id="${newId}"] [data-direction="-1"]`).click();
    await mode(page, "leadership");
    assert.equal(await page.locator("[data-briefing-id]").first().getAttribute("data-briefing-id"), newId);
    assert.match(await text(page, ".briefing"), /Decision:.*Choose the fictional review scope.*Demo lead A/);
    await nav(page, "updates");
    assert.match(await text(page, `[data-update-id="${newId}"]`), /fictional review note.*Decision:/s);
    await mode(page, "engineering");
    await nav(page, "write");
    await page.locator(`[data-written-id="${newId}"] [data-action="edit-written"]`).click();
    await written(page, "title").fill("Revised synthetic leadership request");
    await page.locator("#written-form button[type='submit']").click();
    await page.locator(`[data-written-id="${newId}"] [data-action="archive-written"]`).click();
    assert.equal(await page.locator(".writing-list > li").count(), 3);
    await page.locator(".written-history summary").click();
    assert.match(await text(page, ".written-history"), /Synthetic leadership request/);
    assert.match(await text(page, ".written-history"), /Revised synthetic leadership request/);
    await page.locator(`[data-action="restore-written"][data-id="${newId}"]`).click();
    assert.equal(await page.locator(".writing-list > li").count(), 4);
    await page.locator(`[data-written-id="${newId}"] [data-action="edit-written"]`).click();
    await written(page, "title").fill("This cancelled title must not publish");
    await page.locator("[data-action='cancel-written']").click();
    await page.locator("#discard-edits").click();
    assert.match(await text(page, `[data-written-id="${newId}"]`), /Revised synthetic leadership request/);
    await page.locator("[data-written-id='update-2'] [data-action='archive-written']").click();
    await page.locator("[data-action='new-written']").click();
    await written(page, "title").fill("Replacement fictional briefing bullet");
    await written(page, "scope").selectOption("system:2");
    await page.locator("#written-form button[type='submit']").click();
    await page.locator(".written-history summary").click();
    await page.locator("[data-action='restore-written'][data-id='update-2']").click();
    assert.match(await text(page, ".inline-message.error"), /Four briefing bullets are already active/);
    assert.equal(await page.locator(".writing-list > li").count(), 4);
    await page.locator("[data-action='writing-panel'][data-kind='milestones']").click();
    await page.locator("[data-written-id='milestone-1'] [data-action='edit-written']").click();
    await written(page, "title").fill("Synthetic comparison review");
    await written(page, "outcome").fill("Record the fictional comparison decision.");
    await written(page, "targetDate").fill("2026-09-30");
    await written(page, "endDate").fill("2026-09-29");
    await page.locator("#written-form button[type='submit']").click();
    assert.match(await text(page, "#written-errors"), /on or after its start/);
    await written(page, "endDate").fill("2026-10-01");
    await written(page, "status").selectOption("Blocked");
    await written(page, "dependencies").fill("Waiting for fictional timing input.");
    await page.locator("#written-form button[type='submit']").click();
    await mode(page, "leadership");
    assert.match(await text(page, "[data-next-milestone]"), /Synthetic comparison review.*30 Sept? 2026 to 1 Oct 2026.*Blocked.*fictional comparison decision.*fictional timing input/);
    await nav(page, "updates");
    assert.match(await text(page, "[data-milestone-id='milestone-1']"), /Synthetic comparison review.*fictional timing input/s);
    await mode(page, "engineering");
    await nav(page, "write");
    await page.locator("[data-action='writing-panel'][data-kind='milestones']").click();
    await page.locator("[data-written-id='milestone-3'] [data-action='edit-written']").click();
    assert.ok(await written(page, "targetDate").isDisabled());
    assert.match(await text(page, "#linked-target-preview"), /340K physical-qubit objective.*20 Oct 2026/);
    await page.locator("[data-action='cancel-written']").click();
    await page.locator("[data-action='new-written']").click();
    await written(page, "title").fill("Fictional immediate milestone");
    await written(page, "outcome").fill("A new fictional next step.");
    await written(page, "targetDate").fill("2026-09-25");
    await page.locator("#written-form button[type='submit']").click();
    const milestoneId = await page.locator(".writing-list > li").last().getAttribute("data-written-id");
    await mode(page, "leadership");
    assert.match(await text(page, "[data-next-milestone]"), /Fictional immediate milestone/);
    await mode(page, "engineering");
    await nav(page, "write");
    await page.locator("[data-action='writing-panel'][data-kind='milestones']").click();
    await page.locator(`[data-written-id="${milestoneId}"] [data-action="archive-written"]`).click();
    await mode(page, "leadership");
    assert.match(await text(page, "[data-next-milestone]"), /Synthetic comparison review/);
    await page.locator("[data-action='reset']").click();
    assert.equal(await page.locator("[data-briefing-id]").count(), 3);
    assert.match(await text(page, "[data-next-milestone]"), /Confirm the comparison basis/);
  } finally { await context.close(); }
}

async function unsavedHistory() {
  const { page, context } = await createPage();
  try {
    await mode(page, "engineering");
    const editorUrl = page.url();
    await page.fill("#change-note", "Keep this draft through cancelled navigation.");
    await page.evaluate(() => history.back());
    await page.locator("#discard-dialog").waitFor({ state: "visible" });
    assert.equal(page.url(), editorUrl, "Back navigation should be rewound while confirmation is open.");
    await page.locator("#keep-editing").click();
    assert.equal(await page.inputValue("#change-note"), "Keep this draft through cancelled navigation.");
    await page.evaluate(() => history.back());
    await page.locator("#discard-dialog").waitFor({ state: "visible" });
    await page.locator("#discard-edits").click();
    await page.locator("#selected-title").waitFor();
    assert.equal(new URL(page.url()).hash, "#overview");
    await page.goForward();
    assert.equal(new URL(page.url()).hash, "#edit");
    assert.equal(await page.inputValue("#change-note"), "");
    await nav(page, "write");
    await page.locator("[data-action='new-written']").click();
    await written(page, "title").fill("Unsaved written draft");
    await page.evaluate(() => history.back());
    await page.locator("#discard-dialog").waitFor({ state: "visible" });
    await page.locator("#keep-editing").click();
    assert.equal(await written(page, "title").inputValue(), "Unsaved written draft");
    await nav(page, "edit");
    await page.locator("#discard-edits").click();
    assert.equal(new URL(page.url()).hash, "#edit");
  } finally { await context.close(); }
}

async function fixtures() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await context.addInitScript(() => {
      Object.defineProperty(window, "RESOURCE_DEMO", { configurable: true, set(value) {
        const data = structuredClone(value);
        const first = data.workloads[0].snapshots.at(-1);
        data.workloads[1].snapshots.at(-1).metrics = structuredClone(first.metrics);
        first.metrics.logicalOps = "900719925474099312345678901234567890";
        first.metrics.physicalOps = "90071992547409931234567890123456789100";
        data.workloads[2].snapshots.at(-1).metrics.logicalQubits = "0";
        data.workloads[2].snapshots.at(-1).metrics.physicalQubits = "0";
        data.workloads[3].snapshots.at(-1).metrics.logicalQubits = null;
        data.workloads[4].snapshots.at(-2).metrics.logicalOps = "0";
        Object.defineProperty(window, "RESOURCE_DEMO", { value: data, configurable: true });
      } });
    });
    const page = await context.newPage();
    page.on("pageerror", error => pageErrors.push(error.stack));
    await page.goto(route("compare"));
    assert.equal(await page.locator("[data-scatter='qubits'] [data-point]").count(), 7);
    const first = page.locator("[data-scatter='qubits'] [data-point='App 1a']");
    const coincident = page.locator("[data-scatter='qubits'] [data-point='App 1b']");
    assert.equal(await first.getAttribute("data-cx"), await coincident.getAttribute("data-cx"));
    assert.equal(await first.getAttribute("data-cy"), await coincident.getAttribute("data-cy"));
    for (const id of ["App 1a", "App 1b", "App 2b"]) {
      await page.locator(`.point-picker [data-plot="qubits"][data-point="${id}"]`).click();
      assert.match(await text(page, "#point-detail-qubits"), new RegExp(id));
    }
    assert.match(await text(page, "#point-detail-qubits"), /Not plotted: both counts are required/);
    await page.locator(".point-picker [data-plot='operations'][data-point='App 1a']").click();
    assert.equal(await text(page, "#point-detail-operations [data-exact-x]"), "900,719,925,474,099,312,345,678,901,234,567,890");
    const badCoordinates = await page.locator("[data-scatter] [data-point]").evaluateAll(points => points.some(point => !Number.isFinite(Number(point.dataset.cx)) || !Number.isFinite(Number(point.dataset.cy))));
    assert.equal(badCoordinates, false);
    await page.goto(route("overview", { candidate: "App 2c" }));
    assert.match(await page.locator(".delta").first().innerText(), /Percentage unavailable: previous count is zero/);
  } finally { await context.close(); }
}

async function responsiveAndVisual() {
  for (const width of [320, 390, 768, 1440]) {
    const { page, context } = await createPage(route("overview"), { viewport: { width, height: width < 600 ? 844 : 900 } });
    try {
      for (const tab of ["overview", "compare", "write"]) {
        if (tab === "compare") await nav(page, "compare");
        if (tab === "write") {
          await mode(page, "engineering");
          await nav(page, "write");
          await page.locator("[data-action='writing-panel'][data-kind='milestones']").click();
          await page.locator("[data-written-id='milestone-1'] [data-action='edit-written']").click();
        }
        const layout = await page.evaluate(() => ({
          width: innerWidth, scroll: document.documentElement.scrollWidth,
          tooSmall: [...document.querySelectorAll(".workload-date,.assumption-notice,.chart-caption,.milestone-status,.estimate-status,.decision-context p,.field-hint")]
            .filter(element => element.getClientRects().length && parseFloat(getComputedStyle(element).fontSize) < 12).map(element => element.className)
        }));
        assert.ok(layout.scroll <= layout.width + 1, `${tab} overflows at ${width}px: ${layout.scroll}`);
        assert.deepEqual(layout.tooSmall, [], `${tab} text size at ${width}px`);
        if (tab === "overview") {
          assert.ok((await page.locator(".decision-context").boundingBox()).y < (await page.locator(".trend-grid").boundingBox()).y);
        }
        if (tab === "compare") {
          const labels = await page.locator("[data-scatter]").evaluateAll(plots => plots.map(plot => {
            const points = [...plot.querySelectorAll(".marker-point")].map(point => ({ x: point.cx.baseVal.value, y: point.cy.baseVal.value }));
            const boxes = [...plot.querySelectorAll(".point-label")].map(label => ({ x: label.x.baseVal.value, y: label.y.baseVal.value, width: label.width.baseVal.value, height: label.height.baseVal.value }));
            return {
              count: boxes.length,
              overlapsPoint: boxes.some(box => points.some(point => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height)),
              overlapsLabel: boxes.some((box, index) => boxes.slice(index + 1).some(other => box.x < other.x + other.width && box.x + box.width > other.x && box.y < other.y + other.height && box.y + box.height > other.y))
            };
          }));
          for (const label of labels) assert.deepEqual(label, { count: 8, overlapsPoint: false, overlapsLabel: false }, `Point labels at ${width}px`);
        }
        if (artifacts && process.argv.includes("--visual") && [390, 1440].includes(width)) {
          await fs.mkdir(artifacts, { recursive: true });
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: path.join(artifacts, `${width}-${tab}.png`), fullPage: true });
        }
      }
    } finally { await context.close(); }
  }
}

(async () => {
  browser = await chromium.launch(process.env.EDGE_PATH ? { executablePath: process.env.EDGE_PATH, headless: true } : { channel: "msedge", headless: true });
  try {
    await check("fresh-context links, pinned revisions, native modifiers, recovery, and back/forward", routing);
    await check("two eight-candidate plots with exact mapping and keyboard point details", plots);
    await check("atomic estimate validation, exact counts, local-link boundary, history, targets, and zero/basis gaps", estimateSaves);
    await check("briefing CRUD/reorder/archive/limit and synchronized milestone forms", writtenWorkflow);
    await check("unsaved estimate and written navigation preserves the history stack", unsavedHistory);
    await check("coincident, missing, zero, huge-integer plots and zero previous denominators", fixtures);
    await check("320/390/768/1440 layouts, legible labels, and goal-before-chart ordering", responsiveAndVisual);
    assert.deepEqual(pageErrors, [], "No browser runtime errors.");
    if (artifacts) {
      await fs.mkdir(artifacts, { recursive: true });
      await fs.writeFile(path.join(artifacts, "checks.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), results, pageErrors }, null, 2));
    }
    console.log(`${results.length} check groups passed; no browser runtime errors.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
