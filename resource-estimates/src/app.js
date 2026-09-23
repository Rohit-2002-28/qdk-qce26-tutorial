(() => {
  "use strict";

  const DEMO = window.RESOURCE_DEMO;
  const fields = DEMO.fields;
  const routes = new Set(["overview", "compare", "metrics", "updates", "edit", "write", "guide"]);
  const engineeringRoutes = new Set(["edit", "write", "guide"]);
  const main = document.getElementById("main");
  const dialog = document.getElementById("discard-dialog");
  const state = {
    workloads: structuredClone(DEMO.workloads),
    updates: structuredClone(DEMO.updates),
    milestones: structuredClone(DEMO.milestones),
    selected: "App 1a",
    snapshot: "App 1a-2026-09-22-0",
    filter: "all",
    view: "overview",
    exact: false,
    ratios: false,
    history: false,
    draft: null,
    writtenDraft: null,
    writePanel: "updates",
    points: { qubits: "App 1a", operations: "App 1a" },
    hasLocalChanges: false,
    urlError: "",
    notice: "",
    noticeType: "success",
    guideHighlight: "",
    pendingAction: null
  };
  let navigationIndex = 0;
  let navigationUrl = location.href;
  let restoringHistory = false;
  let historyDestination = null;
  const infoIcon = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5m0-9v1.5"/></svg>';
  const checkIcon = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>';
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const isCount = value => value !== null && value !== undefined && /^\d+$/.test(String(value));
  const group = value => isCount(value) ? BigInt(value).toLocaleString("en-US") : "Not supplied";
  const dateValue = value => Date.parse(`${value}T12:00:00Z`);
  const dateLabel = (value, short = false) => new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", ...(short ? {} : { year: "numeric" }), timeZone: "UTC"
  }).format(new Date(dateValue(value)));
  const announce = message => { document.getElementById("announcement").textContent = message; };
  const inputBadge = label => `<span class="input-badge">${escape(label)}</span>`;
  const inlineInfo = text => `<div class="inline-message">${infoIcon}<p>${text}</p></div>`;
  const workload = id => state.workloads.find(item => item.id === id);
  const ordered = item => [...item.snapshots].sort((a, b) => a.asOf.localeCompare(b.asOf) || a.revision - b.revision);
  const latest = item => ordered(item).at(-1);
  const selectedSnapshot = item => item.id === state.selected ? item.snapshots.find(row => row.id === state.snapshot) || latest(item) : latest(item);
  const published = id => latest(DEMO.workloads.find(item => item.id === id));
  const activeUpdates = () => state.updates.filter(update => !update.archived);
  const activeMilestones = () => state.milestones.filter(milestone => !milestone.archived);
  const scopeLabel = scope => scope === "all" ? "All systems" : scope.startsWith("system:") ? `System ${scope.slice(7)}` : scope;
  const appliesTo = (scope, item) => scope === "all" || scope === item.id || scope === `system:${item.system}`;
  const chartSnapshots = (item, selected = selectedSnapshot(item)) => {
    const byDate = new Map();
    for (const snapshot of ordered(item)) {
      if (snapshot.asOf < selected.asOf || (snapshot.asOf === selected.asOf && snapshot.revision <= selected.revision)) {
        byDate.set(snapshot.asOf, snapshot);
      }
    }
    return [...byDate.values()];
  };
  const previousComparable = item => {
    const selected = selectedSnapshot(item);
    return chartSnapshots(item).findLast(snapshot => snapshot.asOf < selected.asOf && snapshot.config === selected.config);
  };

  function urlFor(view = state.view, options = {}) {
    const id = options.selected ?? state.selected;
    const item = workload(id);
    const snapshot = item.snapshots.find(row => row.id === (options.snapshot ?? (id === state.selected ? state.snapshot : latest(item).id)));
    if (!snapshot) throw new Error("Cannot create a link to an unknown snapshot.");
    const url = new URL(location.href);
    url.search = "";
    url.searchParams.set("candidate", id);
    url.searchParams.set("system", options.filter ?? state.filter);
    url.searchParams.set("snapshot", snapshot.id);
    url.searchParams.set("config", snapshot.config);
    url.searchParams.set("mode", engineeringRoutes.has(view) ? "engineering" : "leadership");
    url.hash = view;
    return url.href;
  }

  function candidateUrl(id, snapshot = latest(workload(id)), view = "overview") {
    const item = workload(id);
    return urlFor(view, { selected: id, snapshot: snapshot.id, filter: state.filter === "all" ? "all" : String(item.system) });
  }

  function readLocation(url) {
    const address = new URL(url), params = address.searchParams;
    const view = address.hash.slice(1) || "overview";
    const id = params.get("candidate") || "App 1a";
    const item = workload(id);
    const filter = params.get("system") || "all";
    const requested = params.get("snapshot");
    const snapshot = item && (requested ? item.snapshots.find(row => row.id === requested) : latest(item));
    const known = new Set(["candidate", "system", "snapshot", "config", "mode"]);
    let error = "";
    if (!routes.has(view)) error = `The tab "${view}" is not available.`;
    else if ([...params.keys()].some(key => !known.has(key) || params.getAll(key).length > 1)) error = "This link has unknown or repeated view parameters.";
    else if ([...params.values()].some(value => !value.trim())) error = "This link includes an empty view parameter. Choose a published snapshot to recover.";
    else if (!item) error = `The candidate "${id}" is not part of this published demo.`;
    else if (!["all", "1", "2", "3", "4"].includes(filter)) error = `The system filter "${filter}" is not available.`;
    else if (filter !== "all" && String(item.system) !== filter) error = `${id} does not belong to System ${filter}.`;
    else if (!snapshot) error = `The requested snapshot "${requested}" is unavailable. In-tab edits are not published server data and cannot be reopened after reload or in another tab.`;
    else if (params.has("config") && params.get("config") !== snapshot.config) error = `This snapshot uses ${snapshot.config}, not the requested configuration "${params.get("config")}".`;
    else if (params.has("mode") && params.get("mode") !== (engineeringRoutes.has(view) ? "engineering" : "leadership")) error = "The requested demo view does not match this tab.";
    return {
      view: routes.has(view) ? view : "overview", selected: item ? id : "App 1a",
      filter: error ? "all" : filter, snapshot: snapshot?.id || published(item ? id : "App 1a").id,
      urlError: error
    };
  }

  function scopeLink(record) {
    if (workload(record.scope)) {
      const item = workload(record.scope);
      const snapshot = item.snapshots.find(row => row.id === record.snapshotId) || latest(item);
      return `<a href="${escape(candidateUrl(item.id, snapshot))}" data-nav>${escape(item.id)}</a>`;
    }
    return escape(scopeLabel(record.scope));
  }

  function unavailableView() {
    return `<section class="sheet unavailable-view"><h1>This view is unavailable</h1><p role="alert">${escape(state.urlError)}</p><p>No substitute snapshot is being displayed as if it matched. Recover to the published example below.</p><a class="button primary" data-nav href="${escape(urlFor("overview", { snapshot: published(state.selected).id, filter: "all" }))}">Open published ${escape(state.selected)} snapshot</a></section>`;
  }

  function compact(value) {
    if (!isCount(value)) return "Not supplied";
    const number = BigInt(value);
    if (number < 1000n) return group(number);
    const units = [[1000000000000n, "T"], [1000000000n, "B"], [1000000n, "M"], [1000n, "K"]];
    if (number >= 1000000000000000n) {
      const raw = number.toString();
      const fraction = raw.slice(1, 3).replace(/0+$/, "");
      return `${raw[0]}${fraction ? `.${fraction}` : ""}e+${raw.length - 1}`;
    }
    const [divisor, suffix] = units.find(([unit]) => number >= unit);
    const tenths = (number * 10n + divisor / 2n) / divisor;
    return `${group(tenths / 10n)}${tenths % 10n ? `.${tenths % 10n}` : ""}${suffix}`;
  }

  function ratio(numerator, denominator) {
    if (!isCount(numerator) || !isCount(denominator)) return null;
    const bottom = BigInt(denominator);
    if (bottom === 0n) return null;
    const tenths = (BigInt(numerator) * 10n + bottom / 2n) / bottom;
    return `${group(tenths / 10n)}${tenths % 10n ? `.${tenths % 10n}` : ""}`;
  }

  function ratioNote(snapshot, numerator, denominator) {
    if (!isCount(snapshot.metrics[numerator]) || !isCount(snapshot.metrics[denominator])) return "A required count is missing.";
    return "The logical count is zero.";
  }

  function percentage(part, total) {
    const denominator = BigInt(total);
    if (denominator === 0n) return null;
    const tenths = (BigInt(part) * 1000n + denominator / 2n) / denominator;
    return `${group(tenths / 10n)}${tenths % 10n ? `.${tenths % 10n}` : ""}%`;
  }

  function parseCount(raw) {
    const text = String(raw).trim();
    if (!text) throw new Error("Enter a count; an empty cell is not zero.");
    if (text.length > 4096) throw new Error("This preview accepts up to 4,096 digits per count.");
    if (text.includes(",") && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) {
      throw new Error("Use correctly grouped commas, for example 120,000,000.");
    }
    const match = text.replaceAll(",", "").match(/^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
    if (!match) throw new Error("Enter a non-negative whole number, not a suffix such as M or K.");
    const fraction = match[2] || "";
    const exponent = Number(match[3] || "0");
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 4096) throw new Error("The exponent is too large for this preview.");
    const digits = match[1] + fraction;
    const shift = exponent - fraction.length;
    if (shift >= 0) {
      const result = BigInt(digits + "0".repeat(shift)).toString();
      if (result.length > 4096) throw new Error("This preview accepts up to 4,096 digits per count.");
      return result;
    }
    const cut = digits.length + shift;
    if (cut <= 0) {
      if (/^0+$/.test(digits)) return "0";
      throw new Error("The count must resolve to a whole number.");
    }
    if (!/^0+$/.test(digits.slice(cut))) throw new Error("The count must resolve to a whole number.");
    return BigInt(digits.slice(0, cut)).toString();
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function changeMarkup(item, key) {
    const selected = selectedSnapshot(item);
    const previous = previousComparable(item);
    if (!previous) return '<div class="delta"><strong class="unavailable">Change unavailable</strong></div>';
    if (!isCount(previous.metrics[key]) || !isCount(selected.metrics[key])) return '<div class="delta">Comparison unavailable: a count is missing.</div>';
    const before = BigInt(previous.metrics[key]);
    const difference = BigInt(selected.metrics[key]) - before;
    if (before === 0n) return `<div class="delta"><strong class="unavailable">Percentage unavailable: previous count is zero</strong></div>`;
    if (difference === 0n) return `<div class="delta"><strong>Unchanged</strong><span>vs ${dateLabel(previous.asOf, true)}</span></div>`;
    return `<div class="delta"><strong class="${difference > 0n ? "increase" : ""}">${difference > 0n ? "&uarr;" : "&darr;"} ${percentage(difference < 0n ? -difference : difference, before)} ${difference > 0n ? "higher" : "lower"}</strong><span>vs ${dateLabel(previous.asOf, true)}</span></div>`;
  }

  function gateShare(snapshot) {
    if (!snapshot.context.gateBasisConfirmed) return { text: "Needs definition", total: 0n, segments: [] };
    if (["nonClifford", "clifford1", "clifford2"].some(key => !isCount(snapshot.metrics[key]))) return { text: "Missing gate counts", total: 0n, segments: [] };
    const parts = ["nonClifford", "clifford1", "clifford2"].map(key => BigInt(snapshot.metrics[key]));
    const total = parts.reduce((sum, value) => sum + value, 0n);
    return {
      text: total > 0n ? percentage(parts[0], total) : "Not available",
      total,
      segments: total > 0n ? parts.map(value => Number(value * 10000n / total) / 100) : []
    };
  }

  function targetGap(snapshot) {
    const target = snapshot.context.targetPhysicalQubits;
    if (!target) return { text: "Target needed", detail: "An engineer must supply a target.", available: false };
    if (snapshot.config !== snapshot.context.targetConfig) return { text: "Not comparable", detail: "Target and estimate use different assumptions.", available: false };
    if (!isCount(snapshot.metrics.physicalQubits)) return { text: "Current count needed", detail: "No physical-qubit gap can be calculated.", available: false };
    const delta = BigInt(snapshot.metrics.physicalQubits) - BigInt(target);
    const absolute = delta < 0n ? -delta : delta;
    const percent = percentage(absolute, target);
    return {
      text: delta === 0n ? "At target" : `${compact(absolute)} ${delta > 0n ? "above" : "below"} target`,
      detail: delta === 0n ? "Same resource count as the target." : `${percent === null ? "Percentage unavailable for a zero target" : `${percent} ${delta > 0n ? "above" : "below"} target`}; same assumptions.`,
      available: true
    };
  }

  function freshness(snapshot) {
    const days = Math.floor((dateValue(DEMO.referenceDate) - dateValue(snapshot.asOf)) / 86400000);
    if (days < 0) return "Future-dated relative to the demo reference date";
    const cadence = Number(snapshot.context.cadenceDays);
    if (!snapshot.context.cadenceDays) return `${days} days old; reporting cadence not supplied`;
    return days > cadence ? `${days} days old; past the illustrative ${cadence}-day cadence`
      : `${days === 0 ? "Dated on the demo reference date" : `${days} days old`}; within the illustrative ${cadence}-day cadence`;
  }

  function nextExpected(snapshot) {
    if (!snapshot.context.cadenceDays) return "Next estimate date not supplied; no cadence set.";
    const due = new Date(dateValue(snapshot.asOf) + Number(snapshot.context.cadenceDays) * 86400000);
    if (!Number.isFinite(due.getTime())) return "Next estimate date is outside the supported date range.";
    return `Next estimate expected ${dateLabel(due.toISOString().slice(0, 10))} (${snapshot.context.cadenceDays}-day engineer-set cadence).`;
  }

  function contentWidth() {
    const style = getComputedStyle(main);
    return main.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  }

  function trendWidth() {
    const width = Math.min(contentWidth(), 1200) - (window.innerWidth <= 600 ? 34 : 50);
    return Math.max(220, Math.floor(window.innerWidth <= 600 ? width : (width - 40) / 2));
  }

  function chart(item, key, label) {
    const all = chartSnapshots(item);
    const snapshots = all.filter(row => isCount(row.metrics[key]));
    if (!snapshots.length) return '<p class="chart-empty">No counts supplied for this trend.</p>';
    const width = trendWidth(), height = window.innerWidth <= 600 ? 170 : 220, left = 62, right = 18, top = 20, bottom = 35;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const rawMax = snapshots.reduce((max, row) => BigInt(row.metrics[key]) > max ? BigInt(row.metrics[key]) : max, 1n);
    const magnitude = 10n ** BigInt(rawMax.toString().length - 1);
    const maximum = [2n, 5n, 10n].map(value => value * magnitude).find(value => value >= rawMax) || rawMax;
    const firstDate = dateValue(snapshots[0].asOf);
    const lastDate = dateValue(snapshots.at(-1).asOf);
    const x = row => snapshots.length === 1 ? left + plotWidth / 2
      : left + (dateValue(row.asOf) - firstDate) / (lastDate - firstDate) * plotWidth;
    const y = row => top + plotHeight * (1 - Number(BigInt(row.metrics[key]) * 1000000n / maximum) / 1000000);
    const current = selectedSnapshot(item), lastAvailable = snapshots.at(-1);
    const groups = [];
    for (const row of snapshots) {
      if (!groups.length || groups.at(-1)[0].config !== row.config || all.indexOf(row) !== all.indexOf(groups.at(-1).at(-1)) + 1) groups.push([]);
      groups.at(-1).push(row);
    }
    const grid = [0n, maximum / 2n, maximum].map(tick => {
      const ordinate = top + plotHeight * (1 - Number(tick * 1000000n / maximum) / 1000000);
      return `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${ordinate}" y2="${ordinate}"/><text x="${left - 8}" y="${ordinate + 3}" text-anchor="end">${compact(tick)}</text>`;
    }).join("");
    const boundaries = snapshots.slice(1).map((row, index) => {
      const previous = snapshots[index];
      if (row.config === previous.config) return "";
      const abscissa = (x(row) + x(previous)) / 2;
      return `<line class="boundary" x1="${abscissa}" x2="${abscissa}" y1="${top - 4}" y2="${height - bottom + 4}"><title>Assumptions changed by ${dateLabel(row.asOf)}</title></line>`;
    }).join("");
    const paths = groups.map(rows => `<path class="${rows[0].config === current.config ? "current-path" : "old-path"}" d="${rows.map((row, index) => `${index === 0 ? "M" : "L"}${x(row).toFixed(2)},${y(row).toFixed(2)}`).join(" ")}"/>`).join("");
    const points = snapshots.map(row => `<circle class="chart-point${row.config !== current.config ? " old-point" : ""}${row === current ? " selected-point" : ""}" cx="${x(row)}" cy="${y(row)}" r="${row === current ? 4.3 : 3}"><title>${dateLabel(row.asOf)}: ${group(row.metrics[key])}; ${escape(row.config)}</title></circle>`).join("");
    const dateTicks = snapshots.filter((_, index) => index === 0 || index === snapshots.length - 1 || (width > 390 && index === Math.floor(snapshots.length / 2)));
    const ticks = dateTicks.map(row => `<text x="${x(row)}" y="${height - 9}" text-anchor="${row === snapshots[0] ? "start" : row === lastAvailable ? "end" : "middle"}">${dateLabel(row.asOf, true)}</text>`).join("");
    const chartId = `chart-${key}`;
    return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${chartId}-title ${chartId}-description"><title id="${chartId}-title">${escape(item.id)}: ${escape(label)} over time</title><desc id="${chartId}-description">${snapshots.length} dated estimates. Latest available value ${group(lastAvailable.metrics[key])} on ${dateLabel(lastAvailable.asOf)}. Lines are not joined across changes in assumptions or missing counts. Exact values are available in All metrics and history.</desc>${grid}${boundaries}${paths}${points}${ticks}</svg>`;
  }

  function provenance(snapshot) {
    const savedAt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Los_Angeles" }).format(new Date(snapshot.savedAt));
    return `<section><h3>Assumptions &amp; source</h3><dl class="resource-facts">
        <div><dt>Configuration / caveat</dt><dd>${escape(snapshot.config)} &mdash; ${escape(snapshot.caveat)}</dd></div>
        <div><dt>Estimate owner / source</dt><dd>${escape(snapshot.owner)} &middot; ${escape(snapshot.source)}</dd></div>
        <div><dt>Saved at (not the estimate date)</dt><dd>${escape(savedAt)} PT</dd></div>
        <div><dt>Reporting cadence</dt><dd>${escape(nextExpected(snapshot))} ${escape(freshness(snapshot))}. Relative to the ${dateLabel(DEMO.referenceDate)} demo date.</dd></div>
      </dl></section>`;
  }

  function requestMarkup(update, className = "request-note") {
    if (!update.requestKind) return "";
    return `<p class="${className}"><strong>${escape(update.requestKind)}:</strong> ${escape(update.request)} &middot; ${escape(update.requestOwner)} &middot; ${update.requestDue ? `due ${dateLabel(update.requestDue)}` : "due date not supplied"}</p>`;
  }

  function milestoneTarget(milestone) {
    return milestone.targetCandidate ? latest(workload(milestone.targetCandidate)) : null;
  }

  function milestoneDate(milestone) {
    return milestoneTarget(milestone)?.context.targetDate || milestone.targetDate;
  }

  function milestoneWindow(milestone) {
    const date = milestoneDate(milestone);
    if (!date) return "Target date not supplied";
    return `${dateLabel(date)}${!milestone.targetCandidate && milestone.endDate ? ` to ${dateLabel(milestone.endDate)}` : ""}`;
  }

  function targetMarkup(snapshot, compactLine = false) {
    const context = snapshot.context, gap = targetGap(snapshot);
    return `<span data-target-current="${escape(snapshot.metrics.physicalQubits)}"><strong>${compact(snapshot.metrics.physicalQubits)} physical qubits</strong> ${compactLine ? "now" : "in the selected snapshot"}</span> vs <strong>${context.targetPhysicalQubits ? compact(context.targetPhysicalQubits) : "no supplied"} target</strong>${context.targetDate ? ` by ${dateLabel(context.targetDate)}` : ""}. <span data-target-gap>${escape(gap.text)}; ${escape(gap.detail)}</span>`;
  }

  function overviewNotice(item, snapshot) {
    if (!previousComparable(item)) return `<p class="overview-notice">No comparable earlier estimate on <strong>${escape(snapshot.config)}</strong>; cross-version changes are not compared.</p>`;
    if (snapshot.id !== latest(item).id) return "";
    const blocker = activeUpdates().find(update => update.requestKind === "Blocker" && appliesTo(update.scope, item))
      || activeMilestones().find(milestone => milestone.status === "Blocked" && appliesTo(milestone.scope, item));
    if (blocker) return `<p class="overview-notice"><strong>Blocker recorded:</strong> ${escape(blocker.title)}. <a data-nav href="${escape(urlFor("updates"))}">Read blocker</a></p>`;
    const days = Math.floor((dateValue(DEMO.referenceDate) - dateValue(snapshot.asOf)) / 86400000);
    if (snapshot.context.cadenceDays && days > Number(snapshot.context.cadenceDays)) return `<p class="overview-notice"><strong>Update overdue:</strong> ${days} days old against a ${escape(snapshot.context.cadenceDays)}-day cadence, as of the ${dateLabel(DEMO.referenceDate, true)} demo date.</p>`;
    if (days < 0) return '<p class="overview-notice">This estimate is future-dated relative to the demo reference date.</p>';
    return "";
  }

  function resourceDetails(item, snapshot) {
    const share = gateShare(snapshot);
    const opRatio = ratio(snapshot.metrics.physicalOps, snapshot.metrics.logicalOps);
    const qubitRatio = ratio(snapshot.metrics.physicalQubits, snapshot.metrics.logicalQubits);
    return `<details class="resource-details" id="resource-details"><summary>Resource details &amp; assumptions</summary>
      <div class="resource-details-body"><div class="resource-detail-grid">
        <section><h3>Physical resources &amp; target</h3><p class="goal-line">${targetMarkup(snapshot, snapshot.id === latest(item).id)}</p><p>Engineer-set objective, not a forecast. Target basis: ${escape(snapshot.context.targetConfig || "not supplied")}.</p>
          <dl class="resource-facts"><div><dt>Physical operations</dt><dd>${group(snapshot.metrics.physicalOps)}</dd></div></dl>
          <p class="overhead"><span>Physical operations per logical operation</span><strong>${opRatio === null ? "Not available" : `${opRatio} : 1`}</strong>${opRatio === null ? `<span class="ratio-note">${ratioNote(snapshot, "physicalOps", "logicalOps")}</span>` : ""}</p>
          <p class="overhead"><span>Physical qubits per logical qubit</span><strong>${qubitRatio === null ? "Not available" : `${qubitRatio} : 1`}</strong>${qubitRatio === null ? `<span class="ratio-note">${ratioNote(snapshot, "physicalQubits", "logicalQubits")}</span>` : ""}</p><p>Overhead ratios are not runtime speedups.</p>
        </section>
        <section><h3>Runtime &amp; gate share</h3><dl class="resource-facts">
          <div><dt>Estimated runtime</dt><dd>${snapshot.context.runtimeHours ? `${escape(snapshot.context.runtimeHours)} hours` : "Not supplied"}${snapshot.context.runtimeLowHours && snapshot.context.runtimeHighHours ? `; ${escape(snapshot.context.runtimeLowHours)}&ndash;${escape(snapshot.context.runtimeHighHours)} h illustrative range` : "; no range supplied"}. Not a statistical confidence interval.</dd></div>
          <div><dt>Engineer-supplied timing model</dt><dd>${escape(snapshot.context.timingModel || "Timing assumptions not supplied.")}</dd></div>
          <div><dt>Non-Clifford share of classified logical gates</dt><dd>${share.text}${share.total > 0n ? `; 1-qubit Clifford ${percentage(snapshot.metrics.clifford1, share.total)}; 2-qubit Clifford ${percentage(snapshot.metrics.clifford2, share.total)}` : ""}</dd></div>
          <div><dt>Gate-share basis</dt><dd>${escape(snapshot.context.gateBasisConfirmed ? snapshot.context.gateBasis : "Unconfirmed. Engineering must establish compatible gate categories before a share is shown.")}</dd></div>
        </dl></section>
        ${provenance(snapshot)}
        <section id="snapshot-change-note" tabindex="-1"><h3>What changed</h3><p class="written-prose">${escape(snapshot.reason)}</p></section>
      </div>
      <h3>All seven exact counts in this snapshot</h3><div class="table-scroll" tabindex="0" role="region" aria-label="Selected snapshot counts; scroll for all seven metrics"><table class="data-table"><thead><tr>${fields.map(field => `<th scope="col">${escape(field.label)}</th>`).join("")}</tr></thead><tbody><tr>${fields.map(field => `<td>${group(snapshot.metrics[field.key])}</td>`).join("")}</tr></tbody></table></div>
      </div></details>`;
  }

  function overview() {
    const item = workload(state.selected), current = selectedSnapshot(item);
    const historical = current.id !== latest(item).id;
    const snapshots = chartSnapshots(item);
    const otherVersions = snapshots.some(snapshot => snapshot.config !== current.config);
    const missing = snapshots.some(snapshot => !isCount(snapshot.metrics.logicalOps) || !isCount(snapshot.metrics.logicalQubits));
    const explanation = [
      "Changes compare the same configuration.",
      otherVersions ? "Gray: other assumptions; lines break between versions." : "",
      missing ? "Missing counts create gaps, not zeros." : "",
      snapshots.length === 1 ? "One dated snapshot; another is needed for a trend." : ""
    ].filter(Boolean).join(" ");
    return `<div class="overview-page"><div class="overview-heading"><h1>Resource overview</h1>
      <details class="snapshot-picker"><summary>Snapshot history</summary><div class="snapshot-options">
        <label class="field"><span>Choose snapshot</span><select class="inset-select" id="snapshot-select">${ordered(item).reverse().map(snapshot => `<option value="${escape(snapshot.id)}"${snapshot.id === current.id ? " selected" : ""}>${dateLabel(snapshot.asOf)} / ${escape(snapshot.config)} / rev ${snapshot.revision + 1}${snapshot.local ? " / in-tab only" : ""}</option>`).join("")}</select></label>
        <button type="button" class="text-button" data-action="history">View full revision history</button>
      </div></details></div>
      <div class="overview-selection"><div class="candidate-controls">
        <label class="field"><span>System</span><select id="system-filter"><option value="all"${state.filter === "all" ? " selected" : ""}>All systems</option>${[1, 2, 3, 4].map(system => `<option value="${system}"${state.filter === String(system) ? " selected" : ""}>System ${system}</option>`).join("")}</select></label>
        <label class="field"><span>Application candidate</span><select class="inset-select" id="candidate-select">${[1, 2, 3, 4].filter(system => state.filter === "all" || String(system) === state.filter).map(system => `<optgroup label="System ${system}">${state.workloads.filter(candidate => candidate.system === system).map(candidate => `<option value="${escape(candidate.id)}"${candidate.id === item.id ? " selected" : ""}>${escape(candidate.id)}</option>`).join("")}</optgroup>`).join("")}</select></label>
      </div><p class="estimate-meta">${historical ? '<strong>Historical snapshot</strong> &middot; ' : ""}As of <strong>${dateLabel(current.asOf)}</strong> &middot; ${escape(current.maturity)} &middot; ${escape(current.config)}${historical ? ` &middot; revision ${current.revision + 1}` : ""}${current.local ? " &middot; in-tab only" : ""}</p></div>
      ${overviewNotice(item, current)}
      <section class="overview-surface" id="selected-workload" aria-label="${escape(item.id)} logical resources">
        <div class="trend-grid">${[["logicalOps", "Logical operations"], ["logicalQubits", "Logical qubits"]].map(([key, label]) => `<section class="trend" aria-labelledby="${key}-heading"><h2 class="metric-label" id="${key}-heading">${label}</h2><div class="metric-value" data-metric="${key}" title="${group(current.metrics[key])}">${compact(current.metrics[key])}</div>${changeMarkup(item, key)}${chart(item, key, label)}</section>`).join("")}</div>
        <p class="chart-caption">${explanation}</p>
        <p class="snapshot-note"><strong>What changed:</strong> ${current.reason.length <= 160 ? escape(current.reason) : 'A longer engineering note is available. <button class="text-button" type="button" data-action="show-change-note">Read full note</button>'}</p>
        ${resourceDetails(item, current)}
      </section></div>`;
  }

  function historySection() {
    const item = workload(state.selected), current = selectedSnapshot(item);
    return `<section class="sheet" id="snapshot-history"><div class="sheet-heading"><div><h2>${escape(item.id)} &mdash; snapshot history</h2><p>Every saved revision is retained. Charts use the latest revision for each estimate date.</p></div><div class="history-head">${state.history ? `<label class="field-inline">Workload<select id="history-workload">${state.workloads.map(row => `<option${row.id === item.id ? " selected" : ""}>${escape(row.id)}</option>`).join("")}</select></label>` : ""}<button type="button" class="button small" data-action="toggle-history" aria-expanded="${state.history}" aria-controls="history-content">${state.history ? "Hide" : "Show"} history</button></div></div>
      <div id="history-content"${state.history ? "" : " hidden"}><div class="table-scroll"><table class="data-table history-table"><thead><tr><th scope="col">Estimate date</th><th scope="col">Assumptions</th><th scope="col">Logical operations</th><th scope="col">Logical qubits</th><th scope="col">Physical qubits</th><th scope="col">Runtime</th><th scope="col">Revision</th></tr></thead><tbody>
        ${ordered(item).reverse().map(row => `<tr class="${row.id === current.id ? "is-current" : ""}"><th scope="row"><a data-nav href="${escape(candidateUrl(item.id, row))}">${dateLabel(row.asOf)}</a>${row.id === current.id ? '<span class="workload-date">Selected snapshot</span>' : ""}${row.local ? '<span class="workload-date">In-tab only</span>' : ""}</th><td><span class="basis-tag">${escape(row.config)}</span>${row.config !== current.config ? '<span class="workload-date">Different assumptions</span>' : ""}</td><td>${group(row.metrics.logicalOps)}</td><td>${group(row.metrics.logicalQubits)}</td><td>${group(row.metrics.physicalQubits)}</td><td>${row.context.runtimeHours ? `${escape(row.context.runtimeHours)} h` : "Not supplied"}</td><td>${row.revision + 1}</td></tr>`).join("")}
      </tbody></table></div><div class="table-foot"><p>Estimate date is not the save timestamp. Corrections do not erase prior revisions.</p><p>Comparison basis: ${escape(current.config)}</p></div></div></section>`;
  }

  function metrics() {
    const display = state.exact ? group : compact;
    const header = fields.map(field => `<th scope="col">${escape(field.label).replace(" operations", "<br>operations").replace(" gates", "<br>gates").replace(" qubits", "<br>qubits")}</th>`).join("");
    const rows = state.workloads.map(item => {
      const current = latest(item);
      const ratios = state.ratios ? ["physicalQubits", "physicalOps"].map((key, index) => {
        const value = ratio(current.metrics[key], current.metrics[index === 0 ? "logicalQubits" : "logicalOps"]);
        return `<td>${value === null ? "Not available" : `${value} : 1`}</td>`;
      }).join("") : "";
      return `<tr><th scope="row" class="frozen"><a class="workload-button" data-nav href="${escape(candidateUrl(item.id, current))}">${escape(item.id)}</a><span class="workload-date">${dateLabel(current.asOf)}</span></th>${fields.map(field => `<td title="${group(current.metrics[field.key])}">${display(current.metrics[field.key])}</td>`).join("")}${ratios}</tr>`;
    }).join("");
    const contextRows = state.workloads.map(item => {
      const current = latest(item), share = gateShare(current), gap = targetGap(current);
      return `<tr><th scope="row" class="frozen">${escape(item.id)}</th><td>${escape(current.context.runtimeHours || "Not supplied")}${current.context.runtimeHours ? " h" : ""}<small>Engineer-supplied model</small></td><td>${current.context.targetPhysicalQubits ? compact(current.context.targetPhysicalQubits) : "Not supplied"}<small>${current.context.targetDate ? dateLabel(current.context.targetDate) : "No target date"}</small></td><td>${escape(gap.text)}<small>${gap.available ? escape(gap.detail) : "Needs engineering input"}</small></td><td>${share.text}<small>${current.context.gateBasisConfirmed ? "Classified logical gates" : "Confirm the gate basis"}</small></td><td>${escape(current.source)}<small>${escape(current.owner)}</small></td></tr>`;
    }).join("");
    return `<div class="page-heading"><div><h1>All resource metrics</h1><p>Eight independent candidates. One dated snapshot per row. No aggregate totals.</p></div></div>
      <section class="sheet"><div class="sheet-heading"><div><h2>Latest estimates</h2><p>All seven engineering counts, kept together.</p></div><div class="table-tools"><label class="check-label"><input type="checkbox" id="exact-values"${state.exact ? " checked" : ""}>Exact counts</label><label class="check-label"><input type="checkbox" id="show-ratios"${state.ratios ? " checked" : ""}>Show overhead ratios</label></div></div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Latest estimates; scroll horizontally for more columns"><table class="data-table" id="all-metrics-table"><thead><tr class="column-group"><th class="frozen" rowspan="2" scope="col">Workload /<br>estimate date</th><th colspan="5" scope="colgroup">Operations</th><th colspan="2" scope="colgroup">Qubits</th>${state.ratios ? '<th colspan="2" scope="colgroup">Physical per logical</th>' : ""}</tr><tr>${header}${state.ratios ? '<th scope="col">Qubit overhead</th><th scope="col">Operation overhead</th>' : ""}</tr></thead><tbody>${rows}</tbody></table></div>
      <div class="table-foot"><p>${state.exact ? "Exact whole-number counts." : "K = thousand; M = million; B = billion; T = trillion. Toggle Exact counts for full values."}</p><p>Select a workload to open its overview.</p></div></section>
      <section class="sheet"><div class="sheet-heading"><div><h2>Supporting measures</h2><p>Runtime is an engineer-supplied model input, not inferred from counts.</p></div></div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Supporting measures; scroll horizontally for more columns"><table class="data-table secondary-table"><thead><tr><th scope="col" class="frozen">Workload</th><th scope="col">Estimated runtime</th><th scope="col">Physical-qubit target</th><th scope="col">Gap to target</th><th scope="col">Non-Clifford share</th><th scope="col">Source / owner</th></tr></thead><tbody>${contextRows}</tbody></table></div>
      <div class="table-foot"><p>All targets and runtime estimates are dummy engineering inputs. Gaps and gate shares are calculated.</p><p>Gate share uses the three classified gate categories, not an unverified operation total.</p></div></section>
      ${historySection()}
      <section class="sheet"><details class="definitions"><summary>Metric definitions and interpretation</summary><dl>
        <dt>Logical / physical operations</dt><dd>Counts at different implementation levels. Engineering must define which gate, reset, measurement, and correction operations are included. Their ratio is not a speedup.</dd>
        <dt>Gate categories</dt><dd>This demo assumes non-overlapping logical gate categories. Real gate-share calculations require a confirmed common basis and denominator. Do not assume gate counts necessarily sum to all logical operations.</dd>
        <dt>Logical / physical qubits</dt><dd>The supplied resource counts for the workload. Engineering must confirm whether physical qubits include all ancillas, factories, and other overhead, and whether the count is peak simultaneous demand.</dd>
        <dt>Estimated runtime</dt><dd>A separate engineering estimate based on timing, scheduling, parallelism, and the relevant hardware/error-correction configuration. It is not calculated from gate count alone.</dd>
        <dt>Targets and gaps</dt><dd>A target is an engineer-supplied future objective, not a forecast. A gap is shown only when target and current estimate use the same assumptions version.</dd>
      </dl></details></section>`;
  }

  const plotFields = {
    qubits: { x: "logicalQubits", y: "physicalQubits", xLabel: "Logical qubits", yLabel: "Physical qubits", title: "Qubit requirements" },
    operations: { x: "logicalOps", y: "physicalOps", xLabel: "Logical operations", yLabel: "Physical operations", title: "Operation requirements" }
  };

  function pointDetails(kind, id) {
    const item = workload(id), snapshot = latest(item), axes = plotFields[kind];
    const available = isCount(snapshot.metrics[axes.x]) && isCount(snapshot.metrics[axes.y]);
    return `<strong>${escape(id)}</strong> &middot; System ${item.system}
      <p>As of ${dateLabel(snapshot.asOf)} &middot; ${escape(snapshot.config)} &middot; ${escape(snapshot.maturity)}${snapshot.local ? " &middot; in-tab only" : ""}</p>
      <dl><div><dt>${axes.xLabel}</dt><dd data-exact-x>${group(snapshot.metrics[axes.x])}</dd></div><div><dt>${axes.yLabel}</dt><dd data-exact-y>${group(snapshot.metrics[axes.y])}</dd></div></dl>
      ${available ? "" : "<p>Not plotted: both counts are required. Missing values are not treated as zero.</p>"}
      <a data-nav href="${escape(candidateUrl(id, snapshot))}">Open this candidate / snapshot</a>`;
  }

  function scatter(kind) {
    const axes = plotFields[kind];
    const rows = state.workloads.map(item => ({ item, snapshot: latest(item) }));
    const plotted = rows.filter(({ snapshot }) => isCount(snapshot.metrics[axes.x]) && isCount(snapshot.metrics[axes.y]));
    const width = Math.floor((window.innerWidth > 1150 ? (contentWidth() - 24) / 2 : contentWidth()) - (window.innerWidth <= 600 ? 26 : 42));
    const height = 300, left = 68, right = 18, top = 32, bottom = 56;
    const niceMaximum = key => {
      const max = plotted.reduce((value, { snapshot }) => BigInt(snapshot.metrics[key]) > value ? BigInt(snapshot.metrics[key]) : value, 1n);
      const magnitude = 10n ** BigInt(max.toString().length - 1);
      return [1n, 2n, 3n, 4n, 5n, 6n, 8n, 10n].map(step => step * magnitude).find(value => value >= max);
    };
    const xMax = niceMaximum(axes.x), yMax = niceMaximum(axes.y);
    const normalized = (value, max) => Number(BigInt(value) * 1000000n / max) / 1000000;
    const x = value => left + normalized(value, xMax) * (width - left - right);
    const y = value => top + (1 - normalized(value, yMax)) * (height - top - bottom);
    const ticks = max => [...new Set([0n, max / 2n, max])];
    const xTicks = ticks(xMax).map(value => `<line class="grid-line" x1="${x(value)}" x2="${x(value)}" y1="${top}" y2="${height - bottom}"/><text x="${x(value)}" y="${height - bottom + 22}" text-anchor="${value === 0n ? "start" : value === xMax ? "end" : "middle"}">${compact(value)}</text>`).join("");
    const yTicks = ticks(yMax).map(value => `<line class="grid-line" x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/><text x="${left - 9}" y="${y(value) + 4}" text-anchor="end">${compact(value)}</text>`).join("");
    const occupied = [];
    const coordinates = plotted.map(({ snapshot }) => ({ x: x(snapshot.metrics[axes.x]), y: y(snapshot.metrics[axes.y]) }));
    const labelPosition = (cx, cy) => {
      const candidates = [[10, -24], [10, 8], [-34, -24], [-34, 8], [10, -48], [-34, -48], [10, 32], [-34, 32], [38, -24], [-62, -24], [38, 8], [-62, 8]];
      for (let ring = 0; ring < 12; ring++) candidates.push([10, -24 - ring * 23], [-34, 8 + ring * 23]);
      for (let row = top; row <= height - bottom - 21; row += 25) {
        for (let column = left; column <= width - right - 27; column += 32) candidates.push([column - cx, row - cy]);
      }
      for (const [dx, dy] of candidates) {
        const box = { x: Math.min(width - right - 27, Math.max(left, cx + dx)), y: Math.min(height - bottom - 21, Math.max(top, cy + dy)) };
        const coversPoint = coordinates.some(point => point.x >= box.x - 6 && point.x <= box.x + 33 && point.y >= box.y - 6 && point.y <= box.y + 27);
        if (!coversPoint && !occupied.some(other => Math.abs(other.x - box.x) < 31 && Math.abs(other.y - box.y) < 24)) {
          occupied.push(box);
          return box;
        }
      }
      return null;
    };
    const leaders = [];
    const points = plotted.map(({ item, snapshot }) => {
      const cx = x(snapshot.metrics[axes.x]), cy = y(snapshot.metrics[axes.y]);
      const label = labelPosition(cx, cy);
      const code = item.id.replace("App ", "");
      if (label) leaders.push(`<line class="point-leader" x1="${cx}" y1="${cy}" x2="${label.x + 13}" y2="${label.y + 10}" pointer-events="none"/>`);
      return `<g role="button" tabindex="0" data-point="${escape(item.id)}" data-plot="${kind}" data-x="${snapshot.metrics[axes.x]}" data-y="${snapshot.metrics[axes.y]}" data-cx="${cx}" data-cy="${cy}" aria-pressed="${state.points[kind] === item.id}" aria-label="${escape(item.id)}: ${group(snapshot.metrics[axes.x])} ${axes.xLabel.toLowerCase()}, ${group(snapshot.metrics[axes.y])} ${axes.yLabel.toLowerCase()}; ${dateLabel(snapshot.asOf)}; ${escape(snapshot.config)}. Show details.">
        ${label ? `<rect class="point-label" x="${label.x}" y="${label.y}" width="27" height="21"/><text class="point-code" x="${label.x + 13.5}" y="${label.y + 15}" text-anchor="middle">${escape(code)}</text>` : ""}
        <circle class="marker-point" cx="${cx}" cy="${cy}" r="4.5"/></g>`;
    }).join("");
    return `<section class="sheet scatter-sheet" aria-labelledby="${kind}-title"><div class="sheet-heading"><div><h2 id="${kind}-title">${axes.title}</h2><p>Latest dated estimate per candidate &middot; linear count axes</p></div></div><div class="scatter-body">
      <svg class="scatter" viewBox="0 0 ${width} ${height}" data-scatter="${kind}" data-x-max="${xMax}" data-y-max="${yMax}" data-left="${left}" data-top="${top}" data-right="${right}" data-bottom="${bottom}" role="group" aria-labelledby="${kind}-title" aria-describedby="${kind}-help"><text class="axis-label" x="${left}" y="17">${axes.yLabel} (count)</text>${xTicks}${yTicks}${leaders.join("")}${points}<text class="axis-label" x="${(width + left - right) / 2}" y="${height - 9}" text-anchor="middle">${axes.xLabel} (count)</text></svg>
      <p class="comparison-caption" id="${kind}-help">Select a labeled point, or choose a candidate below. Leaders label the true plotted position; coincident points remain individually selectable.</p>
      <div class="point-picker" aria-label="${axes.title}: choose a candidate">${rows.map(({ item }) => `<button type="button" data-point="${escape(item.id)}" data-plot="${kind}" aria-pressed="${state.points[kind] === item.id}">${escape(item.id)}</button>`).join("")}</div>
      <div class="point-detail" id="point-detail-${kind}" aria-live="polite">${pointDetails(kind, state.points[kind])}</div>
      ${plotted.length < rows.length ? `<p class="comparison-caption">${rows.length - plotted.length} candidate(s) have missing counts and are not plotted. See exact data below.</p>` : ""}
      </div></section>`;
  }

  function compare() {
    return `<div class="page-heading"><div><h1>Compare resource requirements</h1><p>All eight independent candidates. Each point uses its own latest dated estimate, regardless of the Overview filter.</p></div></div>
      ${inlineInfo("Different workloads and configurations are not necessarily like-for-like. Lower-left is not a performance ranking. No totals, fitted trend line, or runtime inference. K = thousand; M = million; B = billion.")}
      <div class="compare-grid">${scatter("qubits")}${scatter("operations")}</div>
      <section class="sheet"><details class="definitions"><summary>Exact plot data, dates &amp; configurations (8 candidates)</summary>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Exact plot counts; scroll for all columns"><table class="data-table compare-table" id="compare-data"><thead><tr><th scope="col">Candidate / date</th><th scope="col">Configuration</th><th scope="col">Logical qubits</th><th scope="col">Physical qubits</th><th scope="col">Logical operations</th><th scope="col">Physical operations</th></tr></thead><tbody>
      ${state.workloads.map(item => { const snapshot = latest(item); return `<tr><th scope="row"><a data-nav href="${escape(candidateUrl(item.id, snapshot))}">${escape(item.id)}</a><span class="workload-date">${dateLabel(snapshot.asOf)}${snapshot.local ? " / in-tab only" : ""}</span></th><td>${escape(snapshot.config)}</td>${["logicalQubits", "physicalQubits", "logicalOps", "physicalOps"].map(key => `<td>${group(snapshot.metrics[key])}</td>`).join("")}</tr>`; }).join("")}
      </tbody></table></div><p class="support-caption">Counts remain exact integers. Plot coordinates and tick labels are rounded for display only. A zero is plotted at zero; an absent count is explicitly omitted, never imputed.</p></details></section>`;
  }

  function selectPoint(kind, id, pin = false) {
    if (!plotFields[kind] || !workload(id)) return;
    state.points[kind] = id;
    if (pin) {
      const url = candidateUrl(id, latest(workload(id)), "compare");
      if (url !== navigationUrl) {
        navigationIndex++;
        history.pushState({ resourceDemoIndex: navigationIndex }, "", url);
        navigationUrl = url;
        Object.assign(state, readLocation(url));
        for (const link of document.querySelectorAll("[data-route]")) link.href = urlFor(link.dataset.route);
        for (const link of document.querySelectorAll("[data-mode]")) link.href = urlFor(link.dataset.mode === "engineering" ? "edit" : "overview");
      }
    }
    for (const element of main.querySelectorAll(`[data-plot="${kind}"]`)) element.setAttribute("aria-pressed", String(element.dataset.point === id));
    document.getElementById(`point-detail-${kind}`).innerHTML = pointDetails(kind, id);
  }

  function writtenHistory(kind, engineering = false) {
    const records = state[kind].filter(record => record.archived || record.revisions.length);
    const title = kind === "updates" ? "Written update history" : "Milestone history";
    return `<details class="sheet written-history"><summary>${title} (${records.reduce((count, record) => count + record.revisions.length + (record.archived ? 1 : 0), 0)})</summary>
      <ul class="revision-list">${records.length ? records.map(record => {
        const versions = [...record.revisions, ...(record.archived ? [record] : [])];
        return versions.map((version, index) => `<li><strong>${escape(version.title)}</strong><span class="workload-date">${escape(scopeLabel(version.scope))} &middot; ${escape(version.owner)} &middot; ${kind === "updates" ? dateLabel(version.date) : `${version.targetCandidate ? `Linked ${escape(version.targetCandidate)} objective (dated values remain in estimate history)` : escape(milestoneWindow(version))} / ${escape(version.status)}`} &middot; ${version === record ? "Archived" : `Earlier revision ${index + 1}`}</span><p>${escape(version.body || version.outcome)}</p>${kind === "updates" ? requestMarkup(version) : `<p>${escape(version.dependencies || "")}</p>`}${engineering && version === record ? `<button class="text-button" data-action="restore-written" data-kind="${kind}" data-id="${escape(record.id)}">Restore ${kind === "updates" ? "bullet" : "milestone"}</button>` : ""}</li>`).join("");
      }).join("") : '<li>No archived records or earlier written revisions in this open page.</li>'}</ul></details>`;
  }

  function updates() {
    return `<div class="page-heading"><div><h1>Updates &amp; outlook</h1><p>A short account of what changed, followed by what the team is working toward.</p></div><span class="count-label">Example reporting date: 22 Sep 2026</span></div>
      <div class="updates-layout">
        <section class="sheet"><div class="sheet-heading"><div><h2>Since the last review</h2></div><span class="count-label">${activeUpdates().length} active / 4 maximum</span></div>
          <ul class="update-list">${activeUpdates().map(update => `<li data-update-id="${escape(update.id)}"><div class="update-meta">${scopeLink(update)}<span>&middot; ${dateLabel(update.date)} &middot; ${escape(update.owner)}</span></div><h3>${escape(update.title)}</h3><p class="written-prose">${escape(update.body)}</p>${requestMarkup(update)}</li>`).join("") || '<li>No active bullets. Earlier updates remain in history below.</li>'}</ul>
        </section>
        <section class="sheet"><div class="sheet-heading"><div><h2>What comes next</h2><p>Plans and targets &mdash; not completed results.</p></div></div>
          <ol class="milestones">
            ${activeMilestones().map(milestone => { const target = milestoneTarget(milestone); return `<li data-milestone-id="${escape(milestone.id)}"><div class="milestone-date"><strong>${milestoneDate(milestone) ? dateLabel(milestoneDate(milestone), true) : "TBD"}</strong><span>${milestoneDate(milestone)?.slice(0, 4) || "Date needed"}</span></div><div><div class="update-meta">${scopeLink(milestone)} &middot; ${escape(milestone.owner)}</div><h3>${escape(milestone.title)}</h3><p class="written-prose">${escape(milestone.outcome)}</p><p>${escape(milestoneWindow(milestone))}</p>${target ? `<p data-linked-target="${escape(milestone.targetCandidate)}"><strong>Future objective, not a forecast:</strong> ${targetMarkup(target, true)} Basis: ${escape(target.context.targetConfig)}. Linked to the latest ${escape(milestone.targetCandidate)} target.</p>` : ""}<span class="milestone-status">${escape(milestone.status)}</span>${milestone.dependencies ? `<p class="written-prose">Dependency / caveat: ${escape(milestone.dependencies)}</p>` : ""}</div></li>`; }).join("") || '<li>No active milestones. Earlier plans remain in history below.</li>'}
          </ol>
          <div class="outlook-note">Plans are engineer-authored inputs, not extrapolated predictions. Linked targets use the candidate's latest estimate record; a snapshot link does not pin these written plans.</div>
        </section>
      </div>
      ${writtenHistory("updates")}${writtenHistory("milestones")}`;
  }

  function guide() {
    const rows = [
      ["comparisons", "Change from the previous comparable estimate", "Dated counts, an assumptions/configuration version, and confirmation that snapshots are comparable.", "Count and percentage change. The comparison date is shown. No percentage when the previous denominator is zero or no compatible snapshot exists.", "Under each primary metric", "Calculated"],
      ["reasons", "Why the estimate changed", "A short explanation, implication, any caveat, and an owner. Reuse the estimate note in the written editor; curate up to four active briefing bullets.", "Nothing is inferred from the counts. The snapshot note stays with Overview; the canonical briefing lives in Updates & outlook.", "Snapshot note + written updates", "Engineer input"],
      ["freshness", "Freshness and provenance", "Estimate date, maturity (Provisional or Reviewed), reporting cadence, owner, and source/run reference. Cadence and maturity are descriptive inputs, not approvals or inferred confidence.", "Age against the fixed demo reference date and a cadence exception. Save timestamp is recorded separately.", "Every row + source disclosure", "Input + calculation"],
      ["targets", "Target and gap to target", "Target metric/value, target date, assumptions version, and whether it is a committed or exploratory objective.", "Absolute and percentage gap, only on a compatible basis. No claim that the goal will be achieved.", "Resource details + outlook", "Input + calculation"],
      ["runtime", "Estimated runtime", "Runtime estimate, optional range, and the timing, parallelism, scheduling, and hardware/error-correction assumptions behind it.", "Displayed as provided. Gate counts alone cannot determine elapsed time. The example range is not a statistical confidence interval.", "Resource details + All metrics", "Engineer input"],
      ["gates", "Non-Clifford gate share", "Confirm a common logical/physical level, non-overlapping categories, and a meaningful denominator before enabling the real calculation.", "Non-Clifford count as a share of the sum of the three classified gate counts. If the basis is unconfirmed, show Needs definition.", "Resource details + All metrics", "Definition + calculation"]
    ];
    return `<div class="page-heading"><div><h1>What engineers need to provide</h1><p>One clear contract between the entry table and the leadership view.</p></div><a href="#edit" data-route="edit" class="button">Open entry table &rarr;</a></div>
      ${inlineInfo("<strong>Synthetic examples only.</strong> Do not enter real data in this public demo. A realistic-looking number is not evidence, and the demo-view switch is not access control.")}
      <section class="sheet"><div class="sheet-heading"><div><h2>Additional information: input or calculation?</h2><p>All six additions are included. Derived values are never typed manually.</p></div></div><div class="table-scroll" tabindex="0" role="region" aria-label="Engineering input requirements; scroll horizontally for more columns"><table class="data-table guide-table"><thead><tr><th scope="col">Information</th><th scope="col">Engineers supply</th><th scope="col">Dashboard calculates / displays</th><th scope="col">Where it appears</th></tr></thead><tbody>${rows.map(([id, title, supply, derive, where, type]) => `<tr id="guide-${id}" class="${state.guideHighlight === id ? "guide-highlight" : ""}"><th scope="row"><span class="guide-title">${escape(title)}</span>${inputBadge(type)}</th><td>${escape(supply)}</td><td>${escape(derive)}</td><td>${escape(where)}</td></tr>`).join("")}</tbody></table></div></section>
      <div class="guide-grid"><section class="sheet"><h2>The seven source counts stay unchanged</h2><p>Logical operations, physical operations, non-Clifford gates, 1-qubit Clifford, 2-qubit Clifford, logical qubits, and physical qubits. The input table accepts exact whole numbers and Excel paste. Both physical-to-logical overhead ratios are calculated from the same dated snapshot.</p></section><section class="sheet"><h2>Small amount of context, large reduction in questions</h2><p>For each saved update: confirm its date, write one change note, and review the relevant assumptions and source. Targets and timing models live in the expandable context section so they do not crowd routine count entry.</p></section></div>
      <div class="full-row-note"><p><strong>One place for written context.</strong><br>Use Engineering &gt; Updates &amp; outlook for briefing bullets, explicit requests and milestones. Counts and targets stay in Estimates. Save applies immediately in this tab only.</p><a data-nav class="button" href="${escape(urlFor("write"))}">Open written editor</a></div>
      <div class="full-row-note"><p><strong>Production permissions are a separate requirement.</strong><br>Microsoft Entra ID, explicit viewer/editor assignments, server-side authorization, durable history, and conflict handling still need implementation. This mockup implements none of those security guarantees.</p></div>`;
  }

  function scopeOptions(value) {
    return ["all", ...[1, 2, 3, 4].map(system => `system:${system}`), ...state.workloads.map(item => item.id)]
      .map(scope => `<option value="${escape(scope)}"${scope === value ? " selected" : ""}>${escape(scopeLabel(scope))}</option>`).join("");
  }

  function startWritten(kind, id) {
    if (kind === "updates" && !id && activeUpdates().length >= 4) {
      state.notice = "Four briefing bullets are already active. Archive one before adding another; no bullet has been removed.";
      state.noticeType = "error";
      render();
      return;
    }
    const record = id ? state[kind].find(item => item.id === id) : null;
    const snapshot = latest(workload(state.selected));
    const values = record ? structuredClone(record) : kind === "updates" ? {
      scope: state.selected, title: "", body: snapshot.reason, date: snapshot.asOf, owner: snapshot.owner,
      snapshotId: snapshot.id, requestKind: "", request: "", requestOwner: "", requestDue: ""
    } : {
      scope: state.selected, title: "", outcome: "", targetDate: "", endDate: "", owner: snapshot.owner,
      status: "Planned", dependencies: "", targetCandidate: ""
    };
    state.writePanel = kind;
    state.writtenDraft = { kind, id: record?.id || null, values, dirty: false };
    state.notice = "";
    render();
    document.querySelector('[data-written="title"]').focus();
  }

  function linkedTargetPreview(values) {
    if (!values.targetCandidate) return "Optional. Linking uses the estimate's target value, date and assumptions; there is no second numeric target to maintain here.";
    const snapshot = latest(workload(values.targetCandidate));
    return `${compact(snapshot.context.targetPhysicalQubits)} physical-qubit objective; ${snapshot.context.targetDate ? dateLabel(snapshot.context.targetDate) : "date not supplied"}; ${escape(snapshot.context.targetConfig || "basis not supplied")}. Edit this shared target in Estimates.`;
  }

  function writtenForm() {
    const draft = state.writtenDraft;
    if (!draft) return `<section class="sheet written-empty"><h2>Choose an item to edit</h2><p>Keep one item open at a time. Briefing bullets and milestones appear in the leadership Updates &amp; outlook tab. Older versions stay in history.</p><p>All saves change this open page only. Reloading restores the published synthetic examples.</p></section>`;
    const { kind, values } = draft;
    const field = (key, label, options = {}) => `<label class="field${options.wide ? " wide" : ""}"><span>${label}${options.required ? ' <span class="required">Required</span>' : ""}</span>${options.textarea ? `<textarea data-written="${key}" rows="3" maxlength="${options.max || 1000}">${escape(values[key] || "")}</textarea>` : `<input data-written="${key}" type="${options.type || "text"}" value="${escape(values[key] || "")}"${options.type === "date" ? "" : ` maxlength="${options.max || 120}"`}>`}${options.hint ? `<span class="field-hint">${options.hint}</span>` : ""}</label>`;
    const select = (key, label, options) => `<label class="field"><span>${label}</span><select data-written="${key}">${options.map(([value, text]) => `<option value="${escape(value)}"${values[key] === value ? " selected" : ""}>${escape(text)}</option>`).join("")}</select></label>`;
    return `<section class="sheet"><form id="written-form" class="writing-form" novalidate><h2>${draft.id ? "Edit" : "Add"} ${kind === "updates" ? "briefing bullet" : "milestone"}</h2>
      <div id="written-errors" class="editor-errors" role="alert" tabindex="-1" hidden></div>
      <div class="form-grid"><label class="field"><span>Scope</span><select data-written="scope">${scopeOptions(values.scope)}</select></label>
      ${field("owner", "Owner", { required: true })}
      ${field("title", "Short headline", { wide: true, required: true })}
      ${kind === "updates" ? `${field("date", "Update date", { type: "date", required: true })}<div class="field"><span>Reuse estimate context</span><button type="button" class="button" data-action="reuse-note"${workload(values.scope) ? "" : " disabled"}>Use latest estimate note</button><span class="field-hint">Replaces the body, date and owner for the selected candidate.</span></div>${field("body", "Update / leadership implication", { wide: true, textarea: true, required: true, hint: "Describe what changed and why it matters. Do not infer readiness from resource counts alone." })}` :
        `${field("outcome", "Expected outcome", { wide: true, textarea: true, required: true })}
         ${select("status", "Milestone status", ["Planned", "In progress", "Blocked", "Exploratory", "Done"].map(value => [value, value]))}
         ${select("targetCandidate", "Link a physical-qubit objective", [["", "No linked resource target"], ...state.workloads.map(item => [item.id, `${item.id} target`])])}
         <p id="linked-target-preview" class="wide">${linkedTargetPreview(values)}</p>
         <fieldset id="milestone-dates"${values.targetCandidate ? " disabled" : ""}>${field("targetDate", "Target date / window start", { type: "date", required: !values.targetCandidate })}${field("endDate", "Window end (optional)", { type: "date" })}</fieldset>
         ${field("dependencies", "Dependencies / caveats", { wide: true, textarea: true, hint: "A future objective is not an achieved result or a forecast." })}`}
      </div>
      ${kind === "updates" ? `<details class="optional-request"${values.requestKind ? " open" : ""}><summary>Optional decision, blocker or request</summary><div class="form-grid">
        ${select("requestKind", "Action type", [["", "No explicit action"], ...["Decision", "Blocker", "Request"].map(value => [value, value])])}
        ${field("requestOwner", "Action owner")}
        ${field("request", "Action / decision needed", { wide: true, textarea: true, max: 600 })}
        ${field("requestDue", "Due date (if known)", { type: "date" })}
      </div></details>` : ""}
      <div class="save-bar"><div><strong>In-tab publication only</strong><p>Valid saves appear immediately in leadership views.</p></div><div class="save-bar-actions"><button type="button" class="button" data-action="cancel-written">Cancel</button><button type="submit" class="button primary">Save ${kind === "updates" ? "bullet" : "milestone"}</button></div></div></form></section>`;
  }

  function write() {
    const kind = state.writePanel, records = state[kind].filter(record => !record.archived);
    const full = kind === "updates" && records.length >= 4;
    return `<div class="page-heading"><div><h1>Edit updates &amp; outlook</h1><p>Maintain the briefing and plans shown in the leadership Updates &amp; outlook tab.</p></div><a class="button" data-nav href="${escape(urlFor("updates"))}">Read leadership view</a></div>
      ${inlineInfo("<strong>Demo editing, not access control.</strong> Use fictional text only. Save changes this open page; reload resets all edits.")}
      <div class="writing-tabs" aria-label="Written content"><button type="button" class="button" data-action="writing-panel" data-kind="updates" aria-pressed="${kind === "updates"}">Briefing (${activeUpdates().length}/4 active)</button><button type="button" class="button" data-action="writing-panel" data-kind="milestones" aria-pressed="${kind === "milestones"}">Milestones (${activeMilestones().length})</button></div>
      <div class="writing-layout"><section class="sheet"><div class="sheet-heading"><div><h2>${kind === "updates" ? "Active briefing bullets" : "Active milestones"}</h2><p>${full ? "Four active bullets. Archive one to make room; nothing is dropped automatically." : kind === "updates" ? "Up/down controls set the leadership briefing order." : "Targets are linked to Estimates, never copied as separate numeric inputs."}</p></div><button type="button" class="button" data-action="new-written" data-kind="${kind}"${full ? " disabled" : ""}>Add ${kind === "updates" ? "bullet" : "milestone"}</button></div>
      <ol class="writing-list">${records.map((record, index) => `<li data-written-id="${escape(record.id)}"><h3>${escape(record.title)}</h3><p>${escape(scopeLabel(record.scope))} &middot; ${escape(record.owner)} &middot; ${kind === "updates" ? dateLabel(record.date) : escape(milestoneWindow(record))}</p><div class="record-actions"><button type="button" class="button small" data-action="edit-written" data-kind="${kind}" data-id="${escape(record.id)}">Edit<span class="sr-only"> ${escape(record.title)}</span></button><button type="button" class="button small" data-action="archive-written" data-kind="${kind}" data-id="${escape(record.id)}">Archive<span class="sr-only"> ${escape(record.title)}</span></button>${kind === "updates" ? `<button type="button" class="button small" data-action="move-written" data-id="${escape(record.id)}" data-direction="-1"${index === 0 ? " disabled" : ""} aria-label="Move ${escape(record.title)} up">Up</button><button type="button" class="button small" data-action="move-written" data-id="${escape(record.id)}" data-direction="1"${index === records.length - 1 ? " disabled" : ""} aria-label="Move ${escape(record.title)} down">Down</button>` : ""}</div></li>`).join("") || '<li>No active records. Add one or restore an archived record below.</li>'}</ol></section>${writtenForm()}</div>
      ${writtenHistory(kind, true)}`;
  }

  function recordVersion(record) {
    const { revisions, ...copy } = record;
    return structuredClone(copy);
  }

  function writtenErrors(errors) {
    const box = document.getElementById("written-errors");
    box.hidden = errors.length === 0;
    box.innerHTML = errors.length ? `<strong>Nothing was saved.</strong><ul>${errors.map(error => `<li>${escape(error)}</li>`).join("")}</ul>` : "";
    if (errors.length) box.focus();
  }

  function saveWritten() {
    const draft = state.writtenDraft, values = structuredClone(draft.values), errors = [];
    for (const [key, value] of Object.entries(values)) if (typeof value === "string") values[key] = value.trim();
    for (const input of main.querySelectorAll("[data-written]")) input.removeAttribute("aria-invalid");
    const fail = (key, message) => {
      errors.push(message);
      main.querySelector(`[data-written="${key}"]`)?.setAttribute("aria-invalid", "true");
    };
    for (const key of ["title", "owner", draft.kind === "updates" ? "body" : "outcome"]) {
      if (!values[key]) fail(key, `${key === "body" ? "Update / leadership implication" : key === "outcome" ? "Expected outcome" : key === "title" ? "Short headline" : "Owner"} is required.`);
    }
    for (const [key, limit] of Object.entries({ title: 120, owner: 120, body: 1000, outcome: 1000, dependencies: 1000, request: 600, requestOwner: 120 })) {
      if (values[key]?.length > limit) fail(key, `${key} must be ${limit} characters or fewer.`);
    }
    if (!["all", "system:1", "system:2", "system:3", "system:4", ...state.workloads.map(item => item.id)].includes(values.scope)) fail("scope", "Choose an existing candidate or system scope.");
    if (draft.kind === "updates") {
      if (!validDate(values.date)) fail("date", "Supply a valid update date.");
      if (!draft.id && activeUpdates().length >= 4) errors.push("Four briefing bullets are active. Archive one before adding another.");
      if (!["", "Decision", "Blocker", "Request"].includes(values.requestKind)) fail("requestKind", "Choose a supported action type.");
      if (values.requestKind && (!values.request || !values.requestOwner)) fail("request", "An explicit action needs both its text and its owner.");
      if (!values.requestKind && (values.request || values.requestOwner || values.requestDue)) fail("requestKind", "Choose an action type, or clear the unused action fields.");
      if (values.requestDue && !validDate(values.requestDue)) fail("requestDue", "Supply a valid action due date, or leave it empty.");
    } else {
      if (!["Planned", "In progress", "Blocked", "Exploratory", "Done"].includes(values.status)) fail("status", "Choose a supported milestone status.");
      if (values.targetCandidate) {
        const item = workload(values.targetCandidate);
        if (!item || !appliesTo(values.scope, item)) fail("targetCandidate", "The linked target candidate must belong to the milestone's scope.");
        else if (!isCount(latest(item).context.targetPhysicalQubits) || !validDate(latest(item).context.targetDate)) fail("targetCandidate", "Supply this candidate's target value and date in Estimates before linking it.");
        values.targetDate = "";
        values.endDate = "";
      } else {
        if (!validDate(values.targetDate)) fail("targetDate", "Supply a valid target date or link an existing resource target.");
        if (values.endDate && (!validDate(values.endDate) || values.endDate < values.targetDate)) fail("endDate", "The window end must be a valid date on or after its start.");
      }
    }
    if (errors.length) { writtenErrors(errors); return; }
    const original = draft.id && state[draft.kind].find(record => record.id === draft.id);
    const record = { ...values, id: original?.id || `local-${crypto.randomUUID()}`, archived: false, local: true, savedAt: new Date().toISOString(), revisions: original ? [...original.revisions, recordVersion(original)] : [] };
    if (original) state[draft.kind][state[draft.kind].indexOf(original)] = record;
    else state[draft.kind].push(record);
    state.hasLocalChanges = true;
    state.writtenDraft = null;
    state.noticeType = "success";
    state.notice = `${draft.kind === "updates" ? "Briefing bullet" : "Milestone"} saved to Updates & outlook in this open page only.`;
    render();
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    announce(state.notice);
  }

  function archiveWritten(kind, id, restore = false) {
    if (restore && kind === "updates" && activeUpdates().length >= 4) {
      state.notice = "Four briefing bullets are already active. Archive one before restoring another; nothing changed.";
      state.noticeType = "error";
      render();
      return;
    }
    const record = state[kind].find(item => item.id === id);
    record.revisions.push(recordVersion(record));
    record.archived = !restore;
    record.local = true;
    record.savedAt = new Date().toISOString();
    state.hasLocalChanges = true;
    state.writtenDraft = null;
    state.noticeType = "success";
    state.notice = `${restore ? "Restored" : "Archived"} "${record.title}". Prior text is retained in history; this change exists only in the open page.`;
    render();
    announce(state.notice);
  }

  function moveWritten(id, direction) {
    const active = activeUpdates(), index = active.findIndex(record => record.id === id);
    const other = active[index + direction];
    if (!other) return;
    const from = state.updates.indexOf(active[index]), to = state.updates.indexOf(other);
    [state.updates[from], state.updates[to]] = [state.updates[to], state.updates[from]];
    state.hasLocalChanges = true;
    state.writtenDraft = null;
    render();
    main.querySelector(`[data-written-id="${id}"] [data-action="edit-written"]`).focus();
    announce("Leadership briefing order updated, in this tab only.");
  }

  function newDraft() {
    return {
      asOf: DEMO.referenceDate,
      note: "",
      contextId: state.selected,
      dirty: false,
      checked: new Set(),
      rows: new Map(state.workloads.map(item => {
        const current = latest(item);
        return [item.id, {
          original: structuredClone(current),
          metrics: Object.fromEntries(fields.map(field => [field.key, group(current.metrics[field.key])])),
          config: current.config,
          caveat: current.caveat,
          owner: current.owner,
          source: current.source,
          maturity: current.maturity,
          context: structuredClone(current.context)
        }];
      }))
    };
  }

  function editorContextFields() {
    const draft = state.draft, row = draft.rows.get(draft.contextId);
    const textField = (key, label, value, hint, options = {}) => `<label class="field${options.className ? ` ${options.className}` : ""}"><span>${escape(label)}${options.required ? '<span class="required">Required</span>' : ""}</span><input type="${options.type || "text"}" data-context="${escape(key)}" value="${escape(value)}" ${options.required ? "required" : ""} ${options.inputmode ? `inputmode="${options.inputmode}"` : ""}><span class="field-hint">${escape(hint)}</span></label>`;
    return `<div class="context-workload-select"><label class="field-inline">Context for<select id="context-workload">${state.workloads.map(item => `<option${item.id === draft.contextId ? " selected" : ""}>${escape(item.id)}</option>`).join("")}</select></label><p>${inputBadge("Dummy engineering inputs")} Editing context automatically selects this workload.</p></div>
      <div class="context-fields">
        ${textField("config", "Assumptions version", row.config, "Use a new version when the comparison basis changes.", { required: true })}
        ${textField("owner", "Estimate owner", row.owner, "Who can explain this estimate?", { required: true })}
        ${textField("source", "Source / run reference", row.source, "A traceable source, not a link invented by the dashboard.", { required: true })}
        <label class="field"><span>Estimate maturity</span><select data-context="maturity">${["Provisional", "Reviewed"].map(value => `<option${row.maturity === value ? " selected" : ""}>${value}</option>`).join("")}</select><span class="field-hint">Descriptive engineer input, not an approval gate. Valid Save is immediate.</span></label>
        <label class="field wide"><span>Caveat / assumptions<span class="required">Required</span></span><textarea rows="2" data-context="caveat" required>${escape(row.caveat)}</textarea><span class="field-hint">Shown in full in Resource details &amp; assumptions. Use a new version when the comparison basis changes.</span></label>
        <div class="subsection">Targets and reporting cadence</div>
        ${textField("targetPhysicalQubits", "Physical-qubit target", row.context.targetPhysicalQubits, "Engineer-set objective. Leave blank if no target is agreed.", { inputmode: "numeric" })}
        ${textField("targetDate", "Target date", row.context.targetDate, "A plan, not a promise of a future result.", { type: "date" })}
        ${textField("targetConfig", "Target assumptions version", row.context.targetConfig, "Must match the estimate before a gap is calculated.")}
        ${textField("cadenceDays", "Expected update interval (days)", row.context.cadenceDays, "The example is weekly. Engineering must confirm the real cadence.", { inputmode: "numeric" })}
        <div class="subsection">Runtime: separate from operation counts</div>
        ${textField("runtimeHours", "Estimated runtime (hours)", row.context.runtimeHours, "Supply a timing-model result, not a gate-count conversion.", { inputmode: "decimal" })}
        ${textField("runtimeLowHours", "Illustrative range: lower (hours)", row.context.runtimeLowHours, "Optional; state what the range represents.", { inputmode: "decimal" })}
        ${textField("runtimeHighHours", "Illustrative range: upper (hours)", row.context.runtimeHighHours, "This demo does not claim statistical confidence.", { inputmode: "decimal" })}
        <label class="field wide"><span>Runtime model and assumptions</span><textarea rows="2" data-context="timingModel">${escape(row.context.timingModel)}</textarea><span class="field-hint">Include cycle timing, parallelism, scheduling, and relevant hardware/error-correction assumptions.</span></label>
        <div class="subsection">Gate share: confirm the denominator first</div>
        <label class="gate-confirm"><input type="checkbox" data-context="gateBasisConfirmed"${row.context.gateBasisConfirmed ? " checked" : ""}><span>The three gate categories are on the same logical/physical level and do not overlap. Their sum is a meaningful denominator for the displayed share.</span></label>
        ${textField("gateBasis", "Gate-basis definition", row.context.gateBasis, "The current definition is synthetic and must be confirmed by engineering.", { className: "wide" })}
      </div>`;
  }

  function edit() {
    if (!state.draft) state.draft = newDraft();
    const draft = state.draft;
    const checked = draft.checked.size;
    const rows = state.workloads.map((item, rowIndex) => {
      const row = draft.rows.get(item.id);
      return `<tr class="${draft.checked.has(item.id) ? "checked-row" : ""}" data-editor-row="${escape(item.id)}"><th scope="row" class="frozen"><label class="row-select"><input type="checkbox" data-row-check="${escape(item.id)}"${draft.checked.has(item.id) ? " checked" : ""}><span>${escape(item.id)}</span></label></th>${fields.map((field, columnIndex) => `<td><input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-row="${rowIndex}" data-col="${columnIndex}" data-workload-id="${escape(item.id)}" data-field="${field.key}" aria-label="${escape(item.id)} ${escape(field.label)}" value="${escape(row.metrics[field.key])}"></td>`).join("")}</tr>`;
    }).join("");
    return `<div class="page-heading editor-heading"><div><h1>Update resource estimates</h1><p>Paste from Excel or edit a cell. A valid Save updates leadership's view automatically.</p></div><div class="heading-controls"><button class="button" type="button" data-action="sample-edit">Try a sample update</button><a href="#guide" data-route="guide" class="text-button">Input guide &rarr;</a></div></div>
      ${inlineInfo("<strong>Preview only.</strong> Changes stay in this open page; there is no database or real publication. Use dummy data only.")}
      <section class="sheet" aria-label="Engineering entry table">
        <div class="edit-meta"><label class="field"><span>Estimate as of<span class="required">Required</span></span><input type="date" id="estimate-date" value="${escape(draft.asOf)}" required><span class="field-hint">The date these figures describe, not the time you save.</span></label><label class="field"><span>What changed?<span class="required">Required</span></span><input type="text" id="change-note" maxlength="400" value="${escape(draft.note)}" placeholder="Briefly explain the change and its implication." required><span class="field-hint">Applied to selected workloads. For different explanations, save separate batches.</span></label></div>
        <div class="editor-toolbar"><p>Select rows to save. Editing a cell selects its row automatically.</p><button class="text-button" type="button" data-action="paste-help" aria-expanded="false" aria-controls="paste-help">Excel paste help</button></div>
        <div class="paste-help" id="paste-help" hidden>Select the first destination cell and press Ctrl+V (or Command+V). Paste up to eight rows and seven count columns, without headers. Tab moves between cells; arrow keys move between rows. Exact integers, correctly grouped commas, and whole-number scientific notation are accepted. An invalid paste changes no cells.</div>
        <div id="editor-errors" class="editor-errors" role="alert" hidden></div>
        <div class="table-scroll" tabindex="0" role="region" aria-label="Editable estimates; scroll horizontally for all seven counts"><table class="data-table edit-table"><thead><tr><th scope="col" class="frozen"><label class="row-select"><input type="checkbox" id="select-all-rows"${checked === state.workloads.length ? " checked" : ""}><span>Workload</span></label></th>${fields.map(field => `<th scope="col">${escape(field.label).replace(" operations", "<br>operations").replace(" gates", "<br>gates").replace(" qubits", "<br>qubits")}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
        <div class="table-foot"><p>Exact counts only. Ratios, gate share, and target gaps are calculated automatically.</p><p>No changes are committed until Save.</p></div>
        <details class="editor-context" id="editor-context"><summary>Assumptions, targets &amp; supporting inputs<span class="summary-help">Review the context for changed workloads. Runtime is not recalculated from edited counts.</span></summary><div id="context-fields">${editorContextFields()}</div></details>
      </section>
      <div class="save-bar"><div><strong id="selected-row-count">${checked} workload${checked === 1 ? "" : "s"} selected</strong><p>Save the complete valid batch. Previous estimates stay in history.</p></div><div class="save-bar-actions"><button type="button" class="button" data-action="cancel-edit">Cancel</button><button type="button" class="button primary" id="save-updates" data-action="save"${checked === 0 ? " disabled" : ""}>Save updates</button></div></div>`;
  }

  function render() {
    const views = { overview, compare, metrics, updates, edit, write, guide };
    const engineering = engineeringRoutes.has(state.view);
    const tabs = engineering ? [["edit", "Estimates"], ["write", "Updates & outlook"], ["guide", "Input guide"]]
      : [["overview", "Overview"], ["compare", "Compare"], ["metrics", "All metrics"], ["updates", "Updates & outlook"]];
    document.getElementById("view-navigation").innerHTML = tabs.map(([route, text]) => `<a data-route="${route}" href="${escape(urlFor(route))}"${state.view === route ? ' aria-current="page"' : ""}>${escape(text)}</a>`).join("");
    document.getElementById("view-description").textContent = engineering ? "Engineering demo / in-tab edits only" : state.view === "overview" ? "" : "Leadership reading view";
    document.querySelector(".brand").dataset.route = engineering ? "edit" : "overview";
    main.innerHTML = state.urlError ? unavailableView() : `${state.notice ? `<div class="inline-message ${state.noticeType}" role="${state.noticeType === "error" ? "alert" : "status"}">${state.noticeType === "error" ? infoIcon : checkIcon}<p>${escape(state.notice)}</p></div>` : ""}${views[state.view]()}`;
    for (const link of document.querySelectorAll("[data-route]")) {
      link.href = urlFor(link.dataset.route);
      link.dataset.nav = "";
    }
    for (const link of document.querySelectorAll("[data-mode]")) {
      const selected = engineering ? "engineering" : "leadership";
      link.href = urlFor(link.dataset.mode === "engineering" ? "edit" : "overview");
      link.dataset.nav = "";
      if (link.dataset.mode === selected) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    document.getElementById("share-action").disabled = Boolean(state.urlError);
    document.getElementById("share-action").classList.toggle("primary", state.view !== "overview");
    document.title = `${{ overview: "Overview", compare: "Compare", metrics: "All metrics", updates: "Updates & outlook", edit: "Engineering entry", write: "Written updates editor", guide: "Engineering input guide" }[state.view]} - Resource estimates preview`;
  }

  function clearDrafts() {
    state.draft = null;
    state.writtenDraft = null;
  }

  function commitUrl(url, push = true, index = navigationIndex) {
    if (push && url !== navigationUrl) {
      index = navigationIndex + 1;
      history.pushState({ resourceDemoIndex: index }, "", url);
    }
    navigationIndex = index;
    navigationUrl = url;
    clearDrafts();
    Object.assign(state, readLocation(url));
    state.points = { qubits: state.selected, operations: state.selected };
    if (state.snapshot !== latest(workload(state.selected)).id) state.history = true;
    render();
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function commitNavigation(view, options = {}) {
    commitUrl(urlFor(view, options));
  }

  const hasUnsavedEdits = () => Boolean(state.draft?.dirty || state.writtenDraft?.dirty);

  function protectEdits(action) {
    if (hasUnsavedEdits()) {
      state.pendingAction = action;
      if (!dialog.open) dialog.showModal();
    } else action();
  }

  function navigate(view, options = {}) {
    protectEdits(() => commitNavigation(view, options));
  }

  async function copyShareLink() {
    const input = document.getElementById("share-url");
    const status = document.getElementById("share-status");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(input.value);
      status.textContent = "Published view link copied. In-tab edits are not included.";
    } catch (error) {
      status.textContent = "Automatic clipboard copy is unavailable in this browser context. Select and copy the link above manually.";
      input.focus();
      input.select();
    }
  }

  function shareView() {
    const snapshot = selectedSnapshot(workload(state.selected));
    const shareSnapshot = snapshot.local ? published(state.selected) : snapshot;
    const view = state.view === "write" ? "updates" : engineeringRoutes.has(state.view) ? "overview" : state.view;
    document.getElementById("share-url").value = urlFor(view, { snapshot: shareSnapshot.id });
    document.getElementById("share-copy").textContent = `${state.hasLocalChanges ? "This page has in-tab edits that another visitor cannot load. " : ""}This link opens the published ${state.selected} snapshot from ${dateLabel(shareSnapshot.asOf)}, ${shareSnapshot.config}, revision ${shareSnapshot.revision + 1}. It preserves the tab and system filter. No edited counts, written text or owner details are put in the URL.`;
    document.getElementById("share-status").textContent = "";
    document.getElementById("share-dialog").showModal();
    void copyShareLink();
  }

  function syncEditorSelection() {
    const draft = state.draft;
    if (!draft) return;
    for (const row of main.querySelectorAll("[data-editor-row]")) {
      const selected = draft.checked.has(row.dataset.editorRow);
      row.classList.toggle("checked-row", selected);
      row.querySelector("[data-row-check]").checked = selected;
    }
    const count = draft.checked.size;
    document.getElementById("selected-row-count").textContent = `${count} workload${count === 1 ? "" : "s"} selected`;
    document.getElementById("save-updates").disabled = count === 0;
    const all = document.getElementById("select-all-rows");
    all.checked = count === state.workloads.length;
    all.indeterminate = count > 0 && count < state.workloads.length;
  }

  function selectEditedRow(id) {
    state.draft.checked.add(id);
    state.draft.dirty = true;
    syncEditorSelection();
  }

  function editorErrors(errors) {
    const box = document.getElementById("editor-errors");
    box.hidden = errors.length === 0;
    if (!errors.length) { box.textContent = ""; return; }
    box.innerHTML = `<strong>Nothing was saved. Please correct ${errors.length === 1 ? "this issue" : "these issues"}.</strong><ul>${errors.map(error => `<li>${escape(error)}</li>`).join("")}</ul>`;
    announce(`${errors.length} input issue${errors.length === 1 ? "" : "s"}. Nothing was saved.`);
  }

  function validateContext(id, row, errors) {
    const context = structuredClone(row.context);
    for (const field of ["config", "caveat", "owner", "source"]) {
      if (!row[field].trim()) errors.push(`${id}: supply ${field === "config" ? "an assumptions version" : field === "caveat" ? "a visible caveat or an explicit unchanged-assumptions note" : `an estimate ${field}`}.`);
    }
    if (!["Provisional", "Reviewed"].includes(row.maturity)) errors.push(`${id}: choose Provisional or Reviewed maturity.`);
    if (context.targetPhysicalQubits.trim()) {
      try { context.targetPhysicalQubits = parseCount(context.targetPhysicalQubits); }
      catch (error) { errors.push(`${id} target: ${error.message}`); }
      if (!validDate(context.targetDate)) errors.push(`${id}: supply a valid target date.`);
      if (!context.targetConfig.trim()) errors.push(`${id}: supply the target's assumptions version.`);
    } else {
      context.targetPhysicalQubits = "";
    }
    if (context.cadenceDays && (!/^\d+$/.test(context.cadenceDays) || Number(context.cadenceDays) <= 0 || !Number.isSafeInteger(Number(context.cadenceDays)))) {
      errors.push(`${id}: the update interval must be a positive whole number of days.`);
    }
    const numericRuntime = key => {
      const value = context[key].trim();
      context[key] = value;
      if (value && (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))) {
        errors.push(`${id}: ${key} must be a finite non-negative number of hours.`);
        return null;
      }
      return value === "" ? null : Number(value);
    };
    const runtime = numericRuntime("runtimeHours"), low = numericRuntime("runtimeLowHours"), high = numericRuntime("runtimeHighHours");
    if (runtime !== null && !context.timingModel.trim()) errors.push(`${id}: supply the runtime model and assumptions.`);
    if ((low === null) !== (high === null)) errors.push(`${id}: provide both runtime range limits, or leave both empty.`);
    if (low !== null && high !== null && (runtime === null || low > high || runtime < low || runtime > high)) errors.push(`${id}: the runtime estimate must sit inside an ordered lower/upper range.`);
    if (context.gateBasisConfirmed && !context.gateBasis.trim()) errors.push(`${id}: supply the confirmed gate-basis definition.`);
    return context;
  }

  function save() {
    const draft = state.draft, errors = [], prepared = [];
    for (const input of main.querySelectorAll('[aria-invalid="true"]')) input.removeAttribute("aria-invalid");
    if (!validDate(draft.asOf)) {
      errors.push("Supply a valid estimate date.");
      document.getElementById("estimate-date").setAttribute("aria-invalid", "true");
    }
    if (!draft.note.trim()) {
      errors.push("Write a short explanation of what changed.");
      document.getElementById("change-note").setAttribute("aria-invalid", "true");
    }
    if (draft.checked.size === 0) errors.push("Select at least one workload to save.");
    for (const id of draft.checked) {
      const row = draft.rows.get(id), metrics = {};
      for (const field of fields) {
        try { metrics[field.key] = parseCount(row.metrics[field.key]); }
        catch (error) {
          errors.push(`${id} - ${field.label}: ${error.message}`);
          main.querySelector(`[data-workload-id="${id}"][data-field="${field.key}"]`).setAttribute("aria-invalid", "true");
        }
      }
      prepared.push({ id, row, metrics, context: validateContext(id, row, errors) });
    }
    if (errors.length) {
      editorErrors(errors);
      document.getElementById("editor-errors").scrollIntoView({ block: "center" });
      return;
    }
    // Validate the entire batch before committing any in-memory snapshot.
    let historicalCount = 0;
    for (const entry of prepared) {
      const item = workload(entry.id);
      if (draft.asOf < latest(item).asOf) historicalCount++;
      const revision = Math.max(-1, ...item.snapshots.filter(snapshot => snapshot.asOf === draft.asOf).map(snapshot => snapshot.revision)) + 1;
      const snapshot = {
        id: `local-${crypto.randomUUID()}`,
        asOf: draft.asOf,
        revision,
        metrics: entry.metrics,
        config: entry.row.config.trim(),
        caveat: entry.row.caveat.trim(),
        owner: entry.row.owner.trim(),
        source: entry.row.source.trim(),
        maturity: entry.row.maturity,
        local: true,
        reason: draft.note.trim(),
        savedAt: new Date().toISOString(),
        context: entry.context
      };
      item.snapshots.push(snapshot);
    }
    state.selected = prepared[0].id;
    state.snapshot = latest(workload(state.selected)).id;
    state.filter = "all";
    state.hasLocalChanges = true;
    const names = prepared.map(row => row.id).join(", ");
    state.noticeType = "success";
    state.notice = `Demo saved: ${names}. Estimate as of ${dateLabel(draft.asOf)}. ${historicalCount ? "Backdated records were added to history; later-dated estimates remain current. " : ""}Counts, targets and plots are synchronized in this open page only. Briefing bullets are unchanged; reuse the saved change note in Engineering > Updates & outlook when a briefing is needed.`;
    state.draft = null;
    commitNavigation("overview");
    announce(state.notice);
  }

  function handlePaste(event) {
    const input = event.target.closest("[data-field]");
    if (!input || state.view !== "edit") return;
    const text = event.clipboardData?.getData("text/plain");
    if (!text || (!text.includes("\t") && !/[\r\n]/.test(text))) return;
    event.preventDefault();
    const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n").map(line => line.split("\t"));
    if (lines.some(line => line.length !== lines[0].length)) {
      editorErrors(["Paste rejected; no cells changed. Select a rectangular range with the same number of columns in every row."]);
      return;
    }
    const startRow = Number(input.dataset.row), startCol = Number(input.dataset.col), patches = [], errors = [];
    for (let rowOffset = 0; rowOffset < lines.length; rowOffset++) {
      const rowIndex = startRow + rowOffset;
      if (rowIndex >= state.workloads.length) { errors.push("The paste extends beyond the eight workloads."); break; }
      for (let columnOffset = 0; columnOffset < lines[rowOffset].length; columnOffset++) {
        const column = startCol + columnOffset;
        if (column >= fields.length) { errors.push("The paste extends beyond the seven count columns. Paste counts without row names or headers."); break; }
        const id = state.workloads[rowIndex].id, key = fields[column].key;
        try { patches.push({ id, key, value: group(parseCount(lines[rowOffset][columnOffset])), rowIndex, column }); }
        catch (error) { errors.push(`${id} - ${fields[column].label}: ${error.message}`); }
      }
    }
    if (errors.length) {
      editorErrors([`Paste rejected; no cells changed. ${errors[0]}`]);
      return;
    }
    for (const patch of patches) {
      state.draft.rows.get(patch.id).metrics[patch.key] = patch.value;
      state.draft.checked.add(patch.id);
      const target = main.querySelector(`[data-row="${patch.rowIndex}"][data-col="${patch.column}"]`);
      target.value = patch.value;
      target.classList.add("changed-cell");
      target.removeAttribute("aria-invalid");
    }
    state.draft.dirty = true;
    editorErrors([]);
    syncEditorSelection();
    announce(`${patches.length} cells pasted. Review the date and change note, then save.`);
  }

  document.addEventListener("click", event => {
    const snapshotPicker = main.querySelector(".snapshot-picker[open]");
    if (snapshotPicker && !snapshotPicker.contains(event.target)) snapshotPicker.open = false;
    const routeLink = event.target.closest("a[data-nav]");
    if (routeLink) {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || routeLink.hasAttribute("download") || (routeLink.target && routeLink.target !== "_self")) return;
      event.preventDefault();
      protectEdits(() => commitUrl(routeLink.href));
      return;
    }
    const point = event.target.closest("[data-point]");
    if (point) {
      selectPoint(point.dataset.plot, point.dataset.point, true);
      return;
    }
    const action = event.target.closest("[data-action]");
    if (action) {
      const name = action.dataset.action;
      if (name === "share") shareView();
      else if (name === "copy-share") void copyShareLink();
      else if (name === "close-share") document.getElementById("share-dialog").close();
      else if (name === "show-change-note") {
        document.getElementById("resource-details").open = true;
        document.getElementById("snapshot-change-note").focus();
      }
      else if (name === "writing-panel") protectEdits(() => {
        state.writtenDraft = null;
        state.writePanel = action.dataset.kind;
        state.notice = "";
        render();
        main.querySelector(`[data-action="writing-panel"][data-kind="${state.writePanel}"]`).focus();
      });
      else if (name === "new-written" || name === "edit-written") protectEdits(() => startWritten(action.dataset.kind, action.dataset.id));
      else if (name === "cancel-written") protectEdits(() => { state.writtenDraft = null; render(); });
      else if (name === "archive-written" || name === "restore-written") protectEdits(() => archiveWritten(action.dataset.kind, action.dataset.id, name === "restore-written"));
      else if (name === "move-written") protectEdits(() => moveWritten(action.dataset.id, Number(action.dataset.direction)));
      else if (name === "reuse-note") {
        const values = state.writtenDraft.values;
        const snapshot = latest(workload(values.scope));
        Object.assign(values, { body: snapshot.reason, owner: snapshot.owner, date: snapshot.asOf, snapshotId: snapshot.id });
        state.writtenDraft.dirty = true;
        for (const key of ["body", "owner", "date"]) main.querySelector(`[data-written="${key}"]`).value = values[key];
        announce("The latest scoped estimate note, owner and date were copied into this unsaved bullet.");
      } else if (name === "history") {
        state.history = true;
        navigate("metrics");
        document.getElementById("snapshot-history").scrollIntoView({ block: "start" });
      } else if (name === "toggle-history") {
        state.history = !state.history;
        render();
        main.querySelector('[data-action="toggle-history"]').focus({ preventScroll: true });
      } else if (name === "guide") {
        state.guideHighlight = action.dataset.section || "";
        navigate("guide");
      } else if (name === "paste-help") {
        const help = document.getElementById("paste-help");
        help.hidden = !help.hidden;
        action.setAttribute("aria-expanded", String(!help.hidden));
      } else if (name === "sample-edit") {
        const id = "App 1a", row = state.draft.rows.get(id);
        const values = ["114000000", "142500000000", "28000000", "66000000", "20000000", "230", "345000"];
        fields.forEach((field, index) => { row.metrics[field.key] = group(values[index]); });
        row.context.runtimeHours = "6.0";
        row.context.runtimeLowHours = "5.4";
        row.context.runtimeHighHours = "6.8";
        state.draft.note = "Demo update: a revised circuit schedule reduced counts on the same assumptions basis.";
        state.draft.checked.add(id);
        state.draft.dirty = true;
        state.draft.contextId = id;
        render();
        for (const cell of main.querySelectorAll(`[data-workload-id="${id}"]`)) cell.classList.add("changed-cell");
        announce("A sample App 1a update is ready. Save to see the dashboard change.");
      } else if (name === "save") save();
      else if (name === "cancel-edit") navigate("overview");
      else if (name === "reset") protectEdits(() => {
        state.workloads = structuredClone(DEMO.workloads);
        state.updates = structuredClone(DEMO.updates);
        state.milestones = structuredClone(DEMO.milestones);
        clearDrafts();
        state.selected = "App 1a";
        state.snapshot = published("App 1a").id;
        state.filter = "all";
        state.points = { qubits: "App 1a", operations: "App 1a" };
        state.hasLocalChanges = false;
        state.exact = false;
        state.ratios = false;
        state.history = false;
        state.notice = "";
        commitNavigation("overview");
        announce("The synthetic example data has been restored.");
      });
      return;
    }
  });

  function captureWritten(target) {
    if (!target.dataset.written || !state.writtenDraft) return false;
    const values = state.writtenDraft.values;
    values[target.dataset.written] = target.value;
    state.writtenDraft.dirty = true;
    target.removeAttribute("aria-invalid");
    if (target.dataset.written === "targetCandidate") {
      document.getElementById("milestone-dates").disabled = Boolean(target.value);
      document.getElementById("linked-target-preview").innerHTML = linkedTargetPreview(values);
      for (const key of ["targetDate", "endDate"]) main.querySelector(`[data-written="${key}"]`).value = target.value ? "" : values[key];
    }
    if (target.dataset.written === "scope" && state.writtenDraft.kind === "updates") {
      values.snapshotId = "";
      main.querySelector('[data-action="reuse-note"]').disabled = !workload(values.scope);
    }
    return true;
  }

  main.addEventListener("change", event => {
    const target = event.target;
    if (captureWritten(target)) return;
    if (target.id === "system-filter") {
      const item = target.value === "all" || String(workload(state.selected).system) === target.value ? workload(state.selected) : state.workloads.find(item => String(item.system) === target.value);
      navigate("overview", { filter: target.value, selected: item.id, snapshot: item.id === state.selected ? state.snapshot : latest(item).id });
      document.getElementById("system-filter").focus();
    } else if (target.id === "candidate-select") {
      navigate("overview", { selected: target.value, snapshot: latest(workload(target.value)).id });
      document.getElementById("candidate-select").focus({ preventScroll: true });
      announce(`${state.selected} selected.`);
    } else if (target.id === "snapshot-select") {
      navigate("overview", { snapshot: target.value });
      main.querySelector(".snapshot-picker > summary").focus({ preventScroll: true });
    } else if (target.id === "exact-values" || target.id === "show-ratios") {
      state[target.id === "exact-values" ? "exact" : "ratios"] = target.checked;
      render();
      document.getElementById(target.id).focus();
    } else if (target.id === "history-workload") {
      navigate("metrics", { selected: target.value, snapshot: latest(workload(target.value)).id, filter: "all" });
      document.getElementById("history-workload").focus({ preventScroll: true });
    } else if (state.view === "edit" && target.dataset.rowCheck) {
      if (target.checked) state.draft.checked.add(target.dataset.rowCheck);
      else state.draft.checked.delete(target.dataset.rowCheck);
      state.draft.dirty = true;
      syncEditorSelection();
    } else if (target.id === "select-all-rows") {
      state.draft.checked = new Set(target.checked ? state.workloads.map(item => item.id) : []);
      state.draft.dirty = true;
      syncEditorSelection();
    } else if (target.id === "context-workload") {
      state.draft.contextId = target.value;
      document.getElementById("context-fields").innerHTML = editorContextFields();
      document.getElementById("context-workload").focus();
    } else if (target.dataset.context === "gateBasisConfirmed") {
      state.draft.rows.get(state.draft.contextId).context.gateBasisConfirmed = target.checked;
      selectEditedRow(state.draft.contextId);
    }
  });

  main.addEventListener("input", event => {
    if (captureWritten(event.target)) return;
    if (state.view !== "edit") return;
    const target = event.target, draft = state.draft;
    if (target.id === "estimate-date") {
      draft.asOf = target.value;
      draft.dirty = true;
      target.removeAttribute("aria-invalid");
    } else if (target.id === "change-note") {
      draft.note = target.value;
      draft.dirty = true;
      target.removeAttribute("aria-invalid");
    } else if (target.dataset.field) {
      draft.rows.get(target.dataset.workloadId).metrics[target.dataset.field] = target.value;
      target.classList.add("changed-cell");
      target.removeAttribute("aria-invalid");
      selectEditedRow(target.dataset.workloadId);
    } else if (target.dataset.context && target.type !== "checkbox") {
      const row = draft.rows.get(draft.contextId);
      if (["config", "caveat", "owner", "source", "maturity"].includes(target.dataset.context)) row[target.dataset.context] = target.value;
      else row.context[target.dataset.context] = target.value;
      selectEditedRow(draft.contextId);
    }
  });

  main.addEventListener("focusout", event => {
    const target = event.target;
    if (state.view !== "edit" || !target.dataset.field) return;
    try {
      const value = group(parseCount(target.value));
      target.value = value;
      state.draft.rows.get(target.dataset.workloadId).metrics[target.dataset.field] = value;
      target.removeAttribute("aria-invalid");
    } catch (error) {
      target.setAttribute("aria-invalid", "true");
      editorErrors([`${target.dataset.workloadId} - ${fields.find(field => field.key === target.dataset.field).label}: ${error.message}`]);
    }
  });

  main.addEventListener("paste", handlePaste);
  main.addEventListener("submit", event => {
    if (event.target.id === "written-form") { event.preventDefault(); saveWritten(); }
  });
  main.addEventListener("focusin", event => {
    const point = event.target.closest("[data-point]");
    if (point) selectPoint(point.dataset.plot, point.dataset.point);
  });
  main.addEventListener("keydown", event => {
    const snapshotPicker = main.querySelector(".snapshot-picker[open]");
    if (event.key === "Escape" && snapshotPicker) {
      event.preventDefault();
      snapshotPicker.open = false;
      snapshotPicker.querySelector("summary").focus();
      return;
    }
    const point = event.target.closest('g[data-point]');
    if (point && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      selectPoint(point.dataset.plot, point.dataset.point, true);
      return;
    }
    const input = event.target.closest("[data-field]");
    if (!input || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    let row = Number(input.dataset.row), column = Number(input.dataset.col);
    if (event.key === "ArrowUp") row--;
    else if (event.key === "ArrowDown") row++;
    else if (event.key === "ArrowLeft" && input.selectionStart === 0 && input.selectionEnd === 0) column--;
    else if (event.key === "ArrowRight" && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) column++;
    else return;
    const next = main.querySelector(`[data-row="${row}"][data-col="${column}"]`);
    if (next) { event.preventDefault(); next.focus(); next.select(); }
  });

  document.getElementById("keep-editing").addEventListener("click", () => {
    dialog.close();
    state.pendingAction = null;
  });
  document.getElementById("discard-edits").addEventListener("click", () => {
    const action = state.pendingAction;
    state.pendingAction = null;
    clearDrafts();
    dialog.close();
    if (action) action();
  });
  dialog.addEventListener("cancel", () => { state.pendingAction = null; });
  function historyChanged() {
    const url = location.href;
    if (restoringHistory) {
      if (url === navigationUrl) {
        restoringHistory = false;
        const destination = historyDestination;
        historyDestination = null;
        protectEdits(() => { clearDrafts(); history.go(destination.index - navigationIndex); });
      }
      return;
    }
    if (url === navigationUrl) return;
    let index = history.state?.resourceDemoIndex;
    if (!Number.isInteger(index) || index === navigationIndex) {
      index = navigationIndex + 1;
      history.replaceState({ resourceDemoIndex: index }, "", url);
    }
    if (hasUnsavedEdits()) {
      // Rewind before asking so Cancel preserves the actual back/forward stack.
      restoringHistory = true;
      historyDestination = { url, index };
      history.go(navigationIndex - index);
    } else commitUrl(url, false, index);
  }
  window.addEventListener("popstate", historyChanged);
  window.addEventListener("hashchange", historyChanged);
  window.addEventListener("beforeunload", event => {
    if (hasUnsavedEdits()) { event.preventDefault(); event.returnValue = ""; }
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.urlError && ["overview", "compare"].includes(state.view) && !dialog.open) render();
    }, 150);
  });

  Object.assign(state, readLocation(location.href));
  state.points = { qubits: state.selected, operations: state.selected };
  navigationUrl = state.urlError ? location.href : urlFor();
  history.replaceState({ resourceDemoIndex: 0 }, "", navigationUrl);
  render();
})();
