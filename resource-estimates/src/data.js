(() => {
  "use strict";

  const fields = [
    { key: "logicalOps", label: "Logical operations", short: "Logical operations", group: "Operations" },
    { key: "physicalOps", label: "Physical operations", short: "Physical operations", group: "Operations" },
    { key: "nonClifford", label: "Non-Clifford gates", short: "Non-Clifford gates", group: "Operations" },
    { key: "clifford1", label: "1-qubit Clifford", short: "1-qubit Clifford", group: "Operations" },
    { key: "clifford2", label: "2-qubit Clifford", short: "2-qubit Clifford", group: "Operations" },
    { key: "logicalQubits", label: "Logical qubits", short: "Logical qubits", group: "Qubits" },
    { key: "physicalQubits", label: "Physical qubits", short: "Physical qubits", group: "Qubits" }
  ];
  const dates = ["2026-08-18", "2026-08-25", "2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"];
  const definitions = [
    ["App 1a", 1, ["120000000", "144000000000", "30000000", "70000000", "20000000", "240", "360000"], "6.2", "340000", "demo-v2"],
    ["App 1b", 1, ["180000000", "270000000000", "60000000", "90000000", "30000000", "320", "640000"], "10.8", "600000", "demo-v1"],
    ["App 2a", 2, ["75000000", "82500000000", "15000000", "45000000", "15000000", "160", "192000"], "3.4", "180000", "demo-v1"],
    ["App 2b", 2, ["95000000", "123500000000", "25000000", "50000000", "20000000", "200", "300000"], "4.7", "280000", "demo-v1"],
    ["App 2c", 2, ["150000000", "240000000000", "45000000", "75000000", "30000000", "280", "504000"], "8.1", "470000", "demo-v1"],
    ["App 3a", 3, ["45000000", "40500000000", "9000000", "27000000", "9000000", "100", "100000"], "2.2", "95000", "demo-v1"],
    ["App 3b", 3, ["60000000", "66000000000", "12000000", "36000000", "12000000", "140", "168000"], "2.9", "160000", "demo-v1"],
    ["App 4", 4, ["220000000", "440000000000", "88000000", "88000000", "44000000", "400", "1000000"], "16.0", "900000", "demo-v1"]
  ];
  const app1History = [
    ["150000000", "225000000000", "45000000", "75000000", "30000000", "280", "480000"],
    ["144000000", "208800000000", "36000000", "80000000", "28000000", "272", "450000"],
    ["138000000", "193200000000", "34000000", "78000000", "26000000", "256", "430000"],
    ["134000000", "187600000000", "34000000", "74000000", "26000000", "256", "420000"],
    ["126000000", "163800000000", "32000000", "72000000", "22000000", "240", "390000"],
    definitions[0][2]
  ];

  const workloads = definitions.map(([id, system, latest, runtime, target, config], index) => {
    const rising = id === "App 2c";
    const scales = rising ? [91, 93, 95, 96, 98, 100] : [128, 122, 116, 110, 106, 100];
    const qubitScales = rising ? [91, 93, 95, 96, 97, 100] : [132, 124, 118, 112, 108, 100];
    const snapshots = dates.map((asOf, dateIndex) => {
      const values = id === "App 1a" ? app1History[dateIndex] : latest.map((value, fieldIndex) => {
        const scale = fieldIndex === 6 ? qubitScales[dateIndex] : scales[dateIndex];
        return (BigInt(value) * BigInt(scale) / 100n).toString();
      });
      const version = id === "App 1a" ? (dateIndex < 3 ? "demo-v1" : "demo-v2")
        : id === "App 4" && dateIndex < 5 ? "demo-v0" : config;
      const hours = id === "App 1a" ? ["8.8", "8.2", "7.8", "7.3", "6.8", "6.2"][dateIndex]
        : (Number(runtime) * scales[dateIndex] / 100).toFixed(1);
      const caveat = id === "App 1a"
        ? "Error-correction assumptions changed on 8 Sep. Earlier versions are not directly comparable."
        : id === "App 4"
          ? "Error-budget assumptions changed on 22 Sep. Earlier estimates are not directly comparable."
          : "Same illustrative workload and hardware assumptions across the displayed period.";
      return {
        id: `${id}-${asOf}-0`,
        asOf,
        revision: 0,
        metrics: Object.fromEntries(fields.map((field, i) => [field.key, values[i]])),
        config: version,
        caveat,
        reason: id === "App 1a" ? "A revised circuit schedule reduced operation count and peak physical-qubit demand."
          : rising ? "A more conservative schedule includes additional operation and qubit overhead."
            : id === "App 4" ? "The error budget was revised; a new comparison baseline is needed."
              : "The circuit estimate was updated using the same illustrative assumptions.",
        owner: `Demo engineer ${String.fromCharCode(65 + index)}`,
        source: `DEMO-RUN-${String(42 + index).padStart(3, "0")}`,
        savedAt: `${asOf}T17:15:00.000Z`,
        maturity: id === "App 4" || rising ? "Provisional" : "Reviewed",
        local: false,
        context: {
          targetPhysicalQubits: target,
          targetDate: "2026-10-20",
          targetConfig: config,
          runtimeHours: hours,
          runtimeLowHours: (Number(hours) * 0.9).toFixed(1),
          runtimeHighHours: (Number(hours) * 1.13).toFixed(1),
          timingModel: "Illustrative cycle timing and parallelism model; no runtime is inferred from gate counts.",
          cadenceDays: "7",
          gateBasisConfirmed: true,
          gateBasis: "Mutually exclusive logical gate categories: non-Clifford, 1-qubit Clifford, and 2-qubit Clifford."
        }
      };
    });
    if (id === "App 3b") {
      snapshots.splice(3, 2);
      Object.assign(snapshots.at(-1), {
        id: "App 3b-2026-09-08-0", asOf: "2026-09-08", savedAt: "2026-09-09T17:15:00.000Z",
        maturity: "Provisional"
      });
    }
    return { id, system, snapshots };
  });

  window.RESOURCE_DEMO = Object.freeze({
    referenceDate: "2026-09-22",
    fields,
    workloads,
    updates: [
      { id: "update-1", date: "2026-09-22", scope: "App 1a", title: "Revised circuit schedule on the same basis", body: "The 22 Sep estimate uses the same demo-v2 basis as 15 Sep. Review the dated counts alongside the physical-qubit objective; the resource change alone does not establish readiness.", owner: "Demo engineer A", snapshotId: "App 1a-2026-09-22-0", requestKind: "", request: "", requestOwner: "", requestDue: "", archived: false, revisions: [] },
      { id: "update-2", date: "2026-09-22", scope: "App 2c", title: "Additional scheduling overhead included", body: "A more conservative schedule is recorded in the 22 Sep estimate. Engineering will review the timing assumptions before drawing runtime conclusions from this change.", owner: "Demo engineer E", snapshotId: "App 2c-2026-09-22-0", requestKind: "", request: "", requestOwner: "", requestDue: "", archived: false, revisions: [] },
      { id: "update-3", date: "2026-09-22", scope: "App 4", title: "New error-budget comparison baseline", body: "The latest configuration is demo-v1. There is no earlier dated snapshot on that basis, so no change percentage is shown.", owner: "Demo engineer H", snapshotId: "App 4-2026-09-22-0", requestKind: "Request", request: "Confirm the next comparison baseline", requestOwner: "Demo engineer H", requestDue: "2026-09-29", archived: false, revisions: [] }
    ],
    milestones: [
      { id: "milestone-1", scope: "App 1a", title: "Confirm the comparison basis", outcome: "Document demo-v2 assumptions and consistent gate categories for the next review.", targetDate: "2026-10-06", endDate: "", owner: "Demo engineer A", status: "Planned", dependencies: "Depends on model review.", targetCandidate: "", archived: false, revisions: [] },
      { id: "milestone-2", scope: "system:2", title: "Refine runtime estimates", outcome: "Review timing and parallelism inputs for System 2, then record a runtime estimate and its caveats.", targetDate: "2026-10-13", endDate: "2026-10-16", owner: "Demo engineer D", status: "In progress", dependencies: "Timing inputs needed; this is not a count-derived forecast.", targetCandidate: "", archived: false, revisions: [] },
      { id: "milestone-3", scope: "App 1a", title: "Evaluate a reduction candidate", outcome: "Evaluate a new circuit candidate against the linked physical-qubit objective.", targetDate: "", endDate: "", owner: "Demo engineer A", status: "Exploratory", dependencies: "Depends on a new estimate using compatible assumptions.", targetCandidate: "App 1a", archived: false, revisions: [] }
    ]
  });
})();
