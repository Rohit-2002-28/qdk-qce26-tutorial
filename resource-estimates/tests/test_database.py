"""Standard-library tests; all disposable fixtures stay underneath this directory."""

from __future__ import annotations

import concurrent.futures
import contextlib
import copy
import http.client
import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import uuid


SERVER_PATH = Path(__file__).resolve().parents[1] / "server.py"
SPEC = importlib.util.spec_from_file_location("resource_estimates_server", SERVER_PATH)
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


def fixture_state():
    workloads = []
    for workload_id in server.WORKLOAD_IDS:
        workloads.append({
            "id": workload_id,
            "name": f"Workload {workload_id}",
            "shortName": workload_id,
            "system": int(workload_id[0]),
            "snapshots": [{
                "id": f"import-{workload_id}",
                "asOf": None,
                "revision": 0,
                "metrics": {key: str(index + 1) for index, key in enumerate(server.METRIC_KEYS)},
                "config": "Configuration supplied by the fixture",
                "caveat": "Imported date and owner are unknown",
                "reason": "",
                "owner": "",
                "source": "Synthetic fixture",
                "maturity": "Unspecified",
                "local": False,
                "savedAt": None,
                "context": {
                    "targetPhysicalQubits": "",
                    "targetWindow": "",
                    "targetConfig": "",
                    "runtimeHours": "",
                    "runtimeLowHours": "",
                    "runtimeHighHours": "",
                    "timingModel": "",
                    "cadenceDays": "",
                    "gateBasisConfirmed": False,
                    "gateBasis": "",
                },
            }],
        })
    return {
        "schemaVersion": 2,
        "systems": [{"id": number, "name": f"System {number}"} for number in range(1, 5)],
        "fields": [
            {"key": key, "label": f"Label {key}", "short": key, "group": "Counts"}
            for key in server.METRIC_KEYS
        ],
        "workloads": workloads,
        "updates": [{
            "id": "import-update",
            "scope": "all",
            "title": "Imported note",
            "body": "Known content without invented attribution.",
            "date": "2026-09-01",
            "owner": "",
            "snapshotId": "",
            "requestKind": "",
            "request": "",
            "requestOwner": "",
            "requestWindow": "",
            "archived": False,
            "revisions": [{"body": "Older note", "owner": ""}],
        }],
        "milestones": [{
            "id": "import-milestone",
            "scope": "all",
            "title": "An imported milestone",
            "outcome": "An explicit outcome",
            "window": "A future sprint, not a due date",
            "owner": "",
            "status": "Exploratory",
            "dependencies": "Clarify the input",
            "targetCandidate": "",
            "archived": False,
            "revisions": [{"title": "Original milestone"}],
        }],
        "roadmap": [
            {
                "id": key, "title": key.capitalize(), "status": "Not assessed",
                "note": "", "owner": "", "window": "",
                "revisions": [{"status": "Not assessed", "note": "Initial assessment"}],
            }
            for key in server.ROADMAP_IDS
        ],
        "assumptions": {"scope": ["Imported verbatim", {"numericMetadata": 1.25}]},
        "sources": [{"label": "Fixture", "text": "No external data or network dependencies"}],
    }


def with_snapshot(data, *, count="123456789012345678901234567890123456789012345678901234567890"):
    proposed = copy.deepcopy(data)
    snapshot = copy.deepcopy(proposed["workloads"][0]["snapshots"][-1])
    snapshot.update({
        "id": "local-estimate-1",
        "asOf": "2026-09-23",
        "revision": 1,
        "owner": "Test operator",
        "config": "New configuration",
        "reason": "A supplied revision",
        "source": "User-provided calculation",
        "maturity": "Provisional",
        "local": True,
        "savedAt": "2026-09-23T18:00:00.000Z",
    })
    snapshot["metrics"]["physicalOps"] = count
    proposed["workloads"][0]["snapshots"].append(snapshot)
    return proposed


class FixtureCase(unittest.TestCase):
    def setUp(self):
        # Explicit dir prevents tempfile from using the operating system's temp area.
        fixture_parent = os.path.relpath(Path(__file__).resolve().parent, Path.cwd())
        self.fixture = tempfile.TemporaryDirectory(prefix=".database-test-", dir=fixture_parent)
        self.addCleanup(self.fixture.cleanup)
        self.base = Path(self.fixture.name).resolve()
        self.repository = self.base / "repository"
        self.dashboard = self.repository / "resource-estimates"
        self.dashboard.mkdir(parents=True)
        (self.repository / ".git").write_text("fixture repository marker", encoding="utf-8")
        (self.dashboard / "index.html").write_text(
            "<!doctype html><title>Fixture dashboard</title><style>body{color:navy}</style>"
            "<script>window.inlineDashboard=true;</script>", encoding="utf-8",
        )
        (self.dashboard / "src").mkdir()
        self.seed = self.dashboard / "src" / "data.json"
        self.initial = fixture_state()
        self.seed_text = json.dumps(self.initial, ensure_ascii=False, indent=2) + "\n"
        self.seed.write_text(self.seed_text, encoding="utf-8", newline="")
        self.database_path = self.base / "private" / "estimates.sqlite3"
        self.database = self.open_database()

    def open_database(self, path=None, seed=None):
        return server.Database(
            path or self.database_path, seed or self.seed,
            dashboard_directory=self.dashboard, repository_root=self.repository,
        )

    def assert_rejected(self, proposed, message=None):
        before = self.database.state()
        before_records = self.database.records()
        with self.assertRaises(server.APIError) as caught:
            self.database.save(before["revision"], proposed, {"kind": "test-invalid", "raw": {"input": "not persisted"}})
        self.assertEqual(caught.exception.status, 422)
        if message:
            self.assertIn(message, str(caught.exception))
        self.assertEqual(self.database.state(), before)
        self.assertEqual(self.database.records(), before_records)


class DatabaseTests(FixtureCase):
    def test_authoritative_seed_and_saved_uuid_keep_raw_and_exact_counts_queryable(self):
        seed_path = SERVER_PATH.parent / "src" / "data.json"
        if not seed_path.is_file():
            self.skipTest("Authoritative seed is not present; synthetic seed tests remain self-contained")
        seed_text = seed_path.read_bytes().decode("utf-8")
        seed = json.loads(seed_text)
        database = self.open_database(path=self.base / "private" / "authoritative.sqlite3", seed=seed_path)
        self.assertEqual(database.state(), {"revision": 0, "data": seed})
        with database.connection() as connection:
            kind, raw, submission = connection.execute(
                "SELECT kind, raw_json, submission_json FROM raw_events"
            ).fetchone()
            metrics = connection.execute(
                "SELECT json_extract(w.value, '$.id'), json_extract(s.value, '$.id'), "
                "m.key, m.value, typeof(m.value) "
                "FROM state, json_each(data_json, '$.workloads') AS w, "
                "json_each(w.value, '$.snapshots') AS s, json_each(s.value, '$.metrics') AS m"
            ).fetchall()
        self.assertEqual(kind, "seed-import")
        self.assertEqual(raw, seed_text)
        self.assertEqual(submission, seed_text)
        expected = [
            (workload["id"], snapshot["id"], key, count, "text")
            for workload in seed["workloads"]
            for snapshot in workload["snapshots"]
            for key, count in snapshot["metrics"].items()
        ]
        self.assertCountEqual(metrics, expected)

        normalized_count = "9007199254740993123456789"
        raw_count = " 9_007_199_254_740_993_123_456_789 "
        proposed = with_snapshot(seed, count=normalized_count)
        snapshot = proposed["workloads"][0]["snapshots"][-1]
        snapshot["id"] = f"saved-{uuid.uuid4()}"
        database.save(0, proposed, {"kind": "snapshot", "raw": {"physicalOps": raw_count}})
        with database.connection() as connection:
            normalized = connection.execute(
                "SELECT m.value, typeof(m.value) "
                "FROM state, json_each(data_json, '$.workloads') AS w, "
                "json_each(w.value, '$.snapshots') AS s, json_each(s.value, '$.metrics') AS m "
                "WHERE json_extract(s.value, '$.id')=? AND m.key='physicalOps'", (snapshot["id"],),
            ).fetchone()
            raw = connection.execute(
                "SELECT json_extract(raw_json, '$.physicalOps') FROM raw_events ORDER BY id DESC LIMIT 1"
            ).fetchone()[0]
        self.assertEqual(normalized, (normalized_count, "text"))
        self.assertEqual(raw, raw_count)
        self.assertEqual(database.state()["data"], proposed)
        self.assertEqual(proposed["sources"], seed["sources"])
        self.assertEqual(proposed["roadmap"], seed["roadmap"])
        self.assertEqual(database.records()["records"][0]["raw"], seed)

    def test_seed_import_preserves_unknowns_and_metadata(self):
        self.assertEqual(self.database.state(), {"revision": 0, "data": self.initial})
        self.assertEqual(sum(len(item["snapshots"][0]["metrics"]) for item in self.initial["workloads"]), 56)
        records = self.database.records()
        self.assertEqual(records["total"], 1)
        self.assertEqual(records["records"][0]["kind"], "seed-import")
        self.assertEqual(records["records"][0]["raw"], self.initial)
        with self.database.connection() as connection:
            raw, submission = connection.execute("SELECT raw_json, submission_json FROM raw_events").fetchone()
        self.assertEqual(raw, self.seed_text)
        self.assertEqual(submission, self.seed_text)

    def test_restart_does_not_reseed_even_if_seed_changes_or_disappears(self):
        proposed = with_snapshot(self.initial)
        expected = self.database.save(0, proposed, {"kind": "estimate", "raw": {"count": "0000123"}})
        self.seed.write_text('{"invalid": "replacement seed"}', encoding="utf-8")
        reopened = self.open_database()
        self.assertEqual(reopened.state(), expected)
        self.seed.unlink()
        self.assertEqual(self.open_database().state(), expected)
        self.assertEqual(self.open_database().records()["total"], 2)

    def test_large_exact_integer_strings_and_leading_zeroes(self):
        exact = "9" * server.MAX_COUNT_DIGITS
        proposed = with_snapshot(self.initial, count=exact)
        proposed["workloads"][0]["snapshots"][-1]["metrics"]["logicalOps"] = "000000123"
        result = self.database.save(0, proposed, {"kind": "estimate", "raw": {"physicalOps": exact}})
        self.assertEqual(result["data"], proposed)
        reopened = self.open_database()
        metrics = reopened.state()["data"]["workloads"][0]["snapshots"][-1]["metrics"]
        self.assertEqual(metrics["physicalOps"], exact)
        self.assertEqual(metrics["logicalOps"], "000000123")
        self.assertEqual(reopened.records()["records"][-1]["raw"]["physicalOps"], exact)

    def test_raw_strings_and_original_submission_are_lossless(self):
        raw = {"typed": "  12,345_678  ", "multiline": "line 1\r\nline 2", "unicode": "μ—量子", "empty": ""}
        action = {"kind": "estimate-input", "raw": raw}
        envelope = {"baseRevision": 0, "data": self.initial, "action": action}
        text = " \n" + json.dumps(envelope, ensure_ascii=False, indent=3) + "\n "
        self.database.save(0, self.initial, action, submission_text=text)
        record = self.database.records()["records"][-1]
        self.assertEqual(record["raw"], raw)
        with self.database.connection() as connection:
            saved, raw_text = connection.execute(
                "SELECT submission_json, raw_json FROM raw_events ORDER BY id DESC LIMIT 1"
            ).fetchone()
        self.assertEqual(saved, text)
        self.assertEqual(json.loads(raw_text), raw)
        self.assertIn('"typed": "  12,345_678  "', raw_text)

    def test_raw_json_may_be_any_value(self):
        for revision, raw in enumerate((None, True, "verbatim", [1, "002", {"a": 3}], 12.5)):
            result = self.database.save(revision, self.initial, {"kind": "raw-value", "raw": raw})
            self.assertEqual(result["revision"], revision + 1)
            self.assertEqual(self.database.records()["records"][-1]["raw"], raw)

    def test_invalid_metrics_do_not_write_or_round(self):
        for value in (123, 1.2, True, "-1", "1e30", "1.0", "", "9" * (server.MAX_COUNT_DIGITS + 1)):
            with self.subTest(value=str(value)[:40]):
                proposed = with_snapshot(self.initial)
                proposed["workloads"][0]["snapshots"][-1]["metrics"]["physicalOps"] = value
                self.assert_rejected(proposed, "integer string")

    def test_invalid_schema_counts_and_ids_are_rejected(self):
        mutations = (
            lambda data: data.update(schemaVersion=2.0),
            lambda data: data["systems"].pop(),
            lambda data: data["systems"][0].update(id=True),
            lambda data: data["fields"][0].update(key="typo"),
            lambda data: data["fields"].pop(),
            lambda data: data["workloads"].pop(),
            lambda data: data["workloads"][0].update(system=5),
            lambda data: data.pop("sources"),
            lambda data: data["roadmap"].pop(),
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                proposed = copy.deepcopy(self.initial)
                mutation(proposed)
                self.assert_rejected(proposed)

    def test_revision_conflict_changes_nothing(self):
        accepted = self.database.save(0, self.initial, {"kind": "first", "raw": "first"})
        with self.assertRaises(server.APIError) as caught:
            self.database.save(0, with_snapshot(self.initial), {"kind": "stale", "raw": "stale"})
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.details, {"currentRevision": 1})
        self.assertEqual(self.database.state(), accepted)
        self.assertEqual(self.database.records()["total"], 2)

    def test_state_and_raw_event_roll_back_together_on_sql_failure(self):
        with self.database.connection() as connection:
            connection.execute(
                "CREATE TRIGGER fail_test_event BEFORE INSERT ON raw_events "
                "WHEN NEW.kind='fail-test' BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.save(0, with_snapshot(self.initial), {"kind": "fail-test", "raw": "must not persist"})
        self.assertEqual(self.database.state(), {"revision": 0, "data": self.initial})
        self.assertEqual(self.database.records()["total"], 1)

    def test_invalid_state_is_rejected_before_beginning_a_write_transaction(self):
        statements = []
        original_connection = self.database.connection

        @contextlib.contextmanager
        def traced_connection():
            with original_connection() as connection:
                connection.set_trace_callback(statements.append)
                yield connection

        proposed = with_snapshot(self.initial)
        proposed["workloads"][0]["snapshots"][-1]["metrics"]["physicalOps"] = 1.5
        with mock.patch.object(self.database, "connection", traced_connection):
            with self.assertRaises(server.APIError):
                self.database.save(0, proposed, {"kind": "invalid", "raw": "1.5"})
        self.assertFalse(any(statement.startswith(("BEGIN", "UPDATE", "INSERT", "COMMIT")) for statement in statements))

    def test_two_database_instances_cannot_overwrite_the_same_revision(self):
        other = self.open_database()
        barrier = threading.Barrier(2)

        def save(database, name):
            barrier.wait(timeout=5)
            try:
                database.save(0, self.initial, {"kind": name, "raw": name})
                return 200
            except server.APIError as error:
                return error.status

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(save, database, name) for database, name in (
                (self.database, "first"), (other, "second"),
            )]
            self.assertEqual(sorted(future.result(timeout=10) for future in futures), [200, 409])
        self.assertEqual(self.database.state()["revision"], 1)
        self.assertEqual(self.database.records()["total"], 2)

    def test_snapshot_mutation_drop_and_reassignment_are_forbidden(self):
        proposed = with_snapshot(self.initial)
        self.database.save(0, proposed, {"kind": "append", "raw": ""})
        for alteration in ("drop", "metric", "context", "move", "date"):
            with self.subTest(alteration=alteration):
                changed = copy.deepcopy(proposed)
                history = changed["workloads"][0]["snapshots"]
                if alteration == "drop":
                    history.pop(0)
                elif alteration == "metric":
                    history[0]["metrics"]["logicalQubits"] = "900"
                elif alteration == "context":
                    history[0]["context"]["targetWindow"] = "A new horizon"
                elif alteration == "move":
                    changed["workloads"][1]["snapshots"].append(history.pop(0))
                else:
                    history[0]["asOf"] = "2026-01-01"
                self.assert_rejected(changed, "immutable")

    def test_new_snapshots_need_real_dates_and_attribution(self):
        for key, value in (
            ("asOf", None), ("asOf", "2026-02-30"), ("asOf", "tomorrow"),
            ("owner", ""), ("reason", " "), ("source", ""), ("config", ""), ("caveat", ""),
            ("savedAt", "2026-09-23T18:00:00"), ("revision", -1), ("local", 1),
        ):
            with self.subTest(key=key, value=value):
                proposed = with_snapshot(self.initial)
                proposed["workloads"][0]["snapshots"][-1][key] = value
                self.assert_rejected(proposed)

    def test_written_record_ids_cannot_be_dropped(self):
        for collection in ("updates", "milestones", "roadmap"):
            with self.subTest(collection=collection):
                proposed = copy.deepcopy(self.initial)
                proposed[collection].pop()
                self.assert_rejected(proposed)

    def test_written_revisions_cannot_be_dropped_or_mutated(self):
        for collection in ("updates", "milestones", "roadmap"):
            for alteration in ("drop", "mutate"):
                with self.subTest(collection=collection, alteration=alteration):
                    proposed = copy.deepcopy(self.initial)
                    revisions = proposed[collection][0]["revisions"]
                    if alteration == "drop":
                        revisions.clear()
                    else:
                        revisions[0]["rewritten"] = True
                    self.assert_rejected(proposed, "revisions are immutable")

    def test_written_edits_can_append_history(self):
        proposed = copy.deepcopy(self.initial)
        update = proposed["updates"][0]
        update["revisions"].append({"body": update["body"], "owner": update["owner"]})
        update.update(body="New update", owner="Test operator", local=True, savedAt="2026-09-23T18:00:00Z")
        self.assertEqual(self.database.save(0, proposed, {"kind": "update", "raw": "New update"})["data"], proposed)

    def test_legacy_roadmap_without_colors_is_preserved_on_save_and_restart(self):
        self.assertTrue(all("color" not in stage for stage in self.initial["roadmap"]))
        proposed = with_snapshot(self.initial)
        result = self.database.save(0, proposed, {"kind": "estimates", "raw": "unchanged roadmap"})
        self.assertEqual(result["data"]["roadmap"], self.initial["roadmap"])
        restarted = self.open_database()
        self.assertEqual(restarted.state()["data"]["roadmap"], self.initial["roadmap"])
        with restarted.connection() as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], server.DATABASE_VERSION)

    def test_roadmap_palette_and_default_persist_without_changing_status(self):
        state = self.database.state()
        for color in ("green", "amber", "red", "blue", "default"):
            with self.subTest(color=color):
                proposed = copy.deepcopy(state["data"])
                stage = proposed["roadmap"][2]
                before = {key: copy.deepcopy(value) for key, value in stage.items() if key != "revisions"}
                stage["revisions"].append(before)
                stage.update(color=color, owner="Test operator", note="Existing evidence; color is presentation only.")
                state = self.database.save(state["revision"], proposed, {"kind": "roadmap", "raw": {"color": color}})
                self.assertEqual(state["data"]["roadmap"][2]["status"], "Not assessed")
                self.assertEqual(state["data"]["roadmap"][2]["revisions"][-1], before)
                self.assertEqual(self.database.records()["records"][-1]["raw"]["color"], color)
        self.assertEqual(self.open_database().state(), state)
        self.assertEqual(state["data"]["roadmap"][2]["color"], "default")
        self.assertNotIn("color", state["data"]["roadmap"][2]["revisions"][1])

    def test_roadmap_invalid_colors_reject_atomically(self):
        for color in ("", "#107c10", "url(https://example.invalid)", "Green", "purple", None, 42, [], {}):
            with self.subTest(color=color):
                proposed = copy.deepcopy(self.initial)
                proposed["roadmap"][0].update(color=color, owner="Test operator", note="Evidence unchanged")
                self.assert_rejected(proposed, "color")

    def test_roadmap_color_change_requires_previous_version(self):
        proposed = copy.deepcopy(self.initial)
        stage = proposed["roadmap"][0]
        stage.update(color="blue", owner="Test operator", note="Existing assessment")
        self.assert_rejected(proposed, "complete previous roadmap record")
        stage["revisions"].append({"color": "default"})
        self.assert_rejected(proposed, "complete previous roadmap record")
        stage["revisions"][-1] = {key: copy.deepcopy(value) for key, value in self.initial["roadmap"][0].items() if key != "revisions"}
        self.database.save(0, proposed, {"kind": "roadmap", "raw": {"color": "blue"}})
        changed = self.database.state()["data"]
        changed["roadmap"][0]["revisions"][-1]["note"] = "Rewritten history"
        self.assert_rejected(changed, "revisions are immutable")

    def test_roadmap_color_in_new_revision_is_validated(self):
        proposed = copy.deepcopy(self.initial)
        proposed["roadmap"][0]["revisions"].append({"color": "#ffffff"})
        self.assert_rejected(proposed, "color")

    def test_stale_color_change_cannot_overwrite_saved_color_or_audit(self):
        def changed(color):
            proposed = copy.deepcopy(self.initial)
            stage = proposed["roadmap"][0]
            stage["revisions"].append({key: copy.deepcopy(value) for key, value in stage.items() if key != "revisions"})
            stage.update(color=color, owner="Test operator", note="Existing assessment")
            return proposed

        first = self.database.save(0, changed("red"), {"kind": "roadmap", "raw": {"color": "red"}})
        records = self.database.records()
        with self.assertRaises(server.APIError) as caught:
            self.open_database().save(0, changed("blue"), {"kind": "roadmap", "raw": {"color": "blue"}})
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.database.state(), first)
        self.assertEqual(self.database.records(), records)

    def test_archive_does_not_invent_historical_owners(self):
        proposed = copy.deepcopy(self.initial)
        proposed["updates"][0]["archived"] = True
        proposed["milestones"][0]["archived"] = True
        result = self.database.save(0, proposed, {"kind": "archive", "raw": ["import-update", "import-milestone"]})
        self.assertEqual(result["data"]["updates"][0]["owner"], "")
        proposed = copy.deepcopy(result["data"])
        proposed["updates"].clear()
        self.assert_rejected(proposed, "cannot be dropped")

    def test_new_or_edited_records_need_required_fields(self):
        for collection, key in (("updates", "body"), ("milestones", "outcome"), ("roadmap", "note")):
            with self.subTest(collection=collection):
                proposed = copy.deepcopy(self.initial)
                proposed[collection][0][key] = "User-written text"
                self.assert_rejected(proposed, "owner")
        for key in ("outcome", "window"):
            proposed = copy.deepcopy(self.initial)
            proposed["milestones"][0].update(owner="Test operator", **{key: ""})
            self.assert_rejected(proposed)
        proposed = copy.deepcopy(self.initial)
        proposed["updates"][0].update(owner="Test operator", requestKind="Request")
        self.assert_rejected(proposed, "request")

    def test_at_most_four_active_updates_with_archived_history_retained(self):
        proposed = copy.deepcopy(self.initial)
        for index in range(3):
            update = copy.deepcopy(proposed["updates"][0])
            update.update(id=f"added-{index}", owner="Test operator", revisions=[])
            proposed["updates"].append(update)
        self.database.save(0, proposed, {"kind": "four-updates", "raw": []})
        fifth = copy.deepcopy(proposed["updates"][0])
        fifth.update(id="fifth", owner="Test operator", revisions=[])
        proposed["updates"].append(fifth)
        self.assert_rejected(proposed, "four unarchived")
        proposed["updates"][0]["archived"] = True
        result = self.database.save(1, proposed, {"kind": "replace-visible", "raw": "keep history"})
        self.assertEqual(len(result["data"]["updates"]), 5)

    def test_scope_and_target_references_are_validated(self):
        mutations = (
            lambda data: data["updates"][0].update(scope="system:5"),
            lambda data: data["updates"][0].update(snapshotId="missing"),
            lambda data: data["updates"][0].update(scope="system:2", snapshotId="import-1a"),
            lambda data: data["milestones"][0].update(targetCandidate="missing"),
            lambda data: data["milestones"][0].update(scope="1b", targetCandidate="1a"),
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                proposed = copy.deepcopy(self.initial)
                mutation(proposed)
                self.assert_rejected(proposed)

    def test_contexts_and_flexible_sprint_labels(self):
        proposed = with_snapshot(self.initial)
        context = proposed["workloads"][0]["snapshots"][-1]["context"]
        context.update(
            targetWindow="Sprint Alpha / after architecture review — not a due date",
            targetPhysicalQubits="10000000000000000000000001",
            targetConfig="Target assumptions version",
            runtimeLowHours="0.25", runtimeHighHours="1.50", runtimeHours="1.0",
            cadenceDays="14", timingModel="Supplied timing", gateBasisConfirmed=True,
            gateBasis="Declared operations and cycle-time convention",
        )
        self.assertEqual(self.database.save(0, proposed, {"kind": "context", "raw": context})["data"], proposed)
        for key, value in (
            ("targetPhysicalQubits", 10), ("targetWindow", "x" * (server.MAX_WINDOW_LENGTH + 1)),
            ("targetWindow", ""), ("targetConfig", " "),
            ("runtimeHours", "NaN"), ("runtimeLowHours", "2"), ("runtimeHighHours", ""),
            ("runtimeHours", ""), ("runtimeHours", "2"), ("runtimeHours", "1e-1"),
            ("runtimeHours", "-1"), ("timingModel", ""),
            ("cadenceDays", "-1"), ("cadenceDays", "0"), ("cadenceDays", "1.5"),
            ("cadenceDays", "9007199254740992"), ("gateBasisConfirmed", "true"), ("gateBasis", ""),
        ):
            with self.subTest(key=key):
                changed = with_snapshot(self.initial)
                changed["workloads"][0]["snapshots"][-1]["id"] = "another-new-snapshot"
                changed["workloads"][0]["snapshots"][-1]["context"] = {**context, key: value}
                with self.assertRaises(server.APIError):
                    server.validate_state(changed, self.initial)

    def test_runtime_zero_is_accepted_without_float_conversion(self):
        proposed = with_snapshot(self.initial)
        context = proposed["workloads"][0]["snapshots"][-1]["context"]
        context.update(
            runtimeHours="0", runtimeLowHours="0", runtimeHighHours="0.000000000000000001",
            timingModel="Explicit zero-valued fixture model", cadenceDays="14",
        )
        result = self.database.save(0, proposed, {"kind": "estimates", "raw": {"runtimeHours": "0"}})
        self.assertEqual(result["data"]["workloads"][0]["snapshots"][-1]["context"], context)

    def test_linked_milestone_uses_latest_target_not_last_inserted_snapshot(self):
        proposed = with_snapshot(self.initial)
        snapshots = proposed["workloads"][0]["snapshots"]
        snapshots[-1]["context"].update(
            targetPhysicalQubits="10000", targetWindow="Sprint 3-4", targetConfig="Target assumptions",
        )
        backdated = copy.deepcopy(snapshots[-1])
        backdated.update(id="saved-backdated", asOf="2026-08-01", revision=100)
        backdated["context"] = copy.deepcopy(self.initial["workloads"][0]["snapshots"][0]["context"])
        snapshots.append(backdated)
        proposed["milestones"][0].update(targetCandidate="1a", window="", owner="Test operator")
        result = self.database.save(0, proposed, {"kind": "milestone", "raw": {"targetCandidate": "1a", "window": ""}})
        self.assertEqual(result["data"]["milestones"][0]["window"], "")

        removed_target = copy.deepcopy(backdated)
        removed_target.update(id="saved-target-removed", asOf="2026-09-24", revision=0)
        proposed["workloads"][0]["snapshots"].append(removed_target)
        self.assert_rejected(proposed, "archive or unlink")
        proposed["milestones"][0]["archived"] = True
        self.database.save(1, proposed, {"kind": "archive", "raw": {"archived": True}})
        proposed["milestones"][0]["archived"] = False
        self.assert_rejected(proposed, "latest target")

    def test_latest_snapshot_order_matches_frontend_date_revision_and_ties(self):
        records = [
            {"id": "unknown", "asOf": None, "revision": 100},
            {"id": "earlier", "asOf": "2026-08-01", "revision": 100},
            {"id": "first-revision", "asOf": "2026-09-23", "revision": 0},
            {"id": "revised", "asOf": "2026-09-23", "revision": 1},
        ]
        self.assertEqual(server.latest_snapshot({"snapshots": records})["id"], "revised")
        records.append({"id": "last-tied-revision", "asOf": "2026-09-23", "revision": 1})
        self.assertEqual(server.latest_snapshot({"snapshots": records})["id"], "last-tied-revision")

    def test_request_windows_are_flexible_but_bounded(self):
        proposed = copy.deepcopy(self.initial)
        proposed["updates"][0].update(
            owner="Test operator", requestKind="Decision", request="Select a candidate",
            requestOwner="Architecture group", requestWindow="During the next planning sprint",
        )
        self.database.save(0, proposed, {"kind": "decision", "raw": "During the next planning sprint"})
        proposed["updates"][0]["requestWindow"] = "x" * (server.MAX_WINDOW_LENGTH + 1)
        self.assert_rejected(proposed, "requestWindow")

    def test_database_paths_inside_repository_or_served_root_are_refused(self):
        for path in (self.repository / "private.sqlite3", self.dashboard / "private.sqlite3", Path("relative.sqlite3")):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.open_database(path=path)
        self.assertFalse((self.repository / "private.sqlite3").exists())

    def test_symlinked_repository_location_is_refused_when_supported(self):
        link = self.base / "linked-repository"
        try:
            link.symlink_to(self.repository, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("Creating symbolic links is not permitted on this machine")
        with self.assertRaises(ValueError):
            self.open_database(path=link / "private.sqlite3")

    def test_invalid_seed_does_not_create_database(self):
        self.seed.write_text('{"schemaVersion":2}', encoding="utf-8")
        path = self.base / "private" / "bad-seed.sqlite3"
        with self.assertRaises(server.APIError):
            self.open_database(path=path)
        self.assertFalse(path.exists())

    def test_unrelated_database_is_not_overwritten(self):
        path = self.base / "private" / "unrelated.sqlite3"
        with contextlib.closing(sqlite3.connect(path)) as connection:
            connection.execute("CREATE TABLE unrelated(value TEXT)")
            connection.execute("INSERT INTO unrelated VALUES ('retain this')")
            connection.commit()
        with self.assertRaises(ValueError):
            self.open_database(path=path)
        with contextlib.closing(sqlite3.connect(path)) as connection:
            self.assertEqual(connection.execute("SELECT value FROM unrelated").fetchone()[0], "retain this")

    def test_raw_table_is_append_only(self):
        with self.database.connection() as connection:
            for statement in ("DELETE FROM raw_events", "UPDATE raw_events SET raw_json='null'"):
                with self.subTest(statement=statement), self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(statement)
        self.assertEqual(self.database.records()["total"], 1)

    def test_default_database_location_is_private_user_state(self):
        variable = "LOCALAPPDATA" if os.name == "nt" else "XDG_STATE_HOME"
        with mock.patch.dict(os.environ, {variable: str(self.base / "user-state")}):
            path = server.default_database_path()
        self.assertEqual(path, self.base / "user-state" / "ResourceEstimates" / "resource-estimates.sqlite3")


class HTTPTests(FixtureCase):
    def setUp(self):
        super().setUp()
        self.httpd = server.LocalServer(self.database, 0, dashboard_directory=self.dashboard)
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.port = self.httpd.server_port
        status, _, body = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.token = json.loads(body)["token"]

    def stop_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        self.assertFalse(self.thread.is_alive())

    def request(self, method, path, *, body=None, headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, {key.lower(): value for key, value in response.getheaders()}, response.read()
        finally:
            connection.close()

    def write_headers(self, **changes):
        headers = {
            "Origin": f"http://127.0.0.1:{self.port}",
            "X-Resource-Token": self.token,
            "Content-Type": "application/json",
            **changes,
        }
        return {key: value for key, value in headers.items() if value is not None}

    def save_body(self, *, base_revision=0, data=None, raw=None):
        return {
            "baseRevision": base_revision, "data": data or self.initial,
            "action": {"kind": "test-http", "raw": raw},
        }

    def assert_api_error(self, response, expected_status):
        status, headers, body = response
        self.assertEqual(status, expected_status, body)
        result = json.loads(body)
        self.assertIn("error", result)
        self.assertIn("code", result)
        self.assertNotIn("data", result)
        self.assertNotIn("token", result)
        self.assertNotIn("access-control-allow-origin", headers)
        self.assertEqual(headers["cache-control"], "no-store")
        return result

    def test_bound_to_ipv4_loopback_only(self):
        self.assertEqual(self.httpd.server_address[0], "127.0.0.1")

    def test_state_contract_and_private_headers(self):
        status, headers, body = self.request("GET", "/api/state")
        result = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(result["data"], self.initial)
        self.assertEqual(result["revision"], 0)
        self.assertEqual(result["storage"], {"kind": "sqlite", "label": "Private local SQLite"})
        self.assertEqual(result["token"], self.token)
        self.assertGreaterEqual(len(self.token), 32)
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertEqual(headers["cross-origin-resource-policy"], "same-origin")
        self.assertIn("frame-ancestors 'none'", headers["content-security-policy"])
        self.assertNotIn("access-control-allow-origin", headers)

    def test_both_dashboard_urls_serve_only_inline_artifact(self):
        expected = (self.dashboard / "index.html").read_bytes()
        for path in ("/", "/resource-estimates/"):
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertEqual(body, expected)
                self.assertIn("script-src 'unsafe-inline'", headers["content-security-policy"])
                self.assertIn("style-src 'unsafe-inline'", headers["content-security-policy"])

    def test_no_arbitrary_files_or_source_paths_are_served(self):
        (self.dashboard / "private.txt").write_text("not served", encoding="utf-8")
        paths = (
            "/index.html", "/private.txt", "/src/data.json", "/resource-estimates/src/data.json",
            "/server.py", "/README.md", "/.git/config", "/../private/estimates.sqlite3",
            "/%2e%2e/private/estimates.sqlite3", "/api/../src/data.json", "/attachments/file",
            "/resource-estimates/../../private/estimates.sqlite3",
        )
        for path in paths:
            with self.subTest(path=path):
                self.assert_api_error(self.request("GET", path), 404)

    def test_no_reset_or_delete_endpoint_can_discard_persisted_history(self):
        self.database.save(0, with_snapshot(self.initial), {"kind": "estimate", "raw": "retain this input"})
        before = self.database.export()
        for path in ("/api/reset", "/api/clear", "/api/delete"):
            for method in ("GET", "POST"):
                with self.subTest(path=path, method=method):
                    self.assert_api_error(self.request(
                        method, path, body=b"{}" if method == "POST" else None, headers=self.write_headers(),
                    ), 404)
        self.assert_api_error(self.request("DELETE", "/api/state", headers=self.write_headers()), 501)
        self.assertEqual(self.database.export(), before)

    def test_missing_dashboard_is_an_explicit_error(self):
        (self.dashboard / "index.html").unlink()
        self.assert_api_error(self.request("GET", "/"), 503)

    def test_host_port_and_rebinding_are_rejected(self):
        for host in ("attacker.example", f"attacker.example:{self.port}", "localhost:1", f"localhost.:{self.port}", ""):
            with self.subTest(host=host):
                self.assert_api_error(self.request("GET", "/api/state", headers={"Host": host}), 403)
        status, _, _ = self.request("GET", "/api/state", headers={"Host": f"LOCALHOST:{self.port}"})
        self.assertEqual(status, 200)

    def test_duplicate_host_is_rejected(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.putrequest("GET", "/api/state", skip_host=True)
            connection.putheader("Host", f"localhost:{self.port}")
            connection.putheader("Host", "attacker.example")
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 403)
            self.assertIn("error", json.loads(response.read()))
        finally:
            connection.close()

    def test_cross_origin_and_fetch_metadata_are_rejected_on_reads(self):
        for path in ("/api/state", "/api/records", "/api/export", "/api/database", "/"):
            for headers in (
                {"Origin": "https://attacker.example"},
                {"Origin": "null"},
                {"Origin": f"http://localhost:{self.port}"},
                {"Sec-Fetch-Site": "cross-site"},
                {"Sec-Fetch-Site": "same-site"},
            ):
                with self.subTest(path=path, headers=headers):
                    self.assert_api_error(self.request("GET", path, headers=headers), 403)
        self.assertEqual(self.request("GET", "/api/state", headers={"Sec-Fetch-Site": "same-origin"})[0], 200)

    def test_write_requires_both_valid_origin_and_token(self):
        for changes in (
            {"X-Resource-Token": None}, {"X-Resource-Token": "wrong"},
            {"Origin": None}, {"Origin": "null"}, {"Origin": "http://localhost:1"},
            {"Origin": f"http://localhost:{self.port}"}, {"Sec-Fetch-Site": "cross-site"},
        ):
            with self.subTest(changes=changes):
                self.assert_api_error(
                    self.request("POST", "/api/save", body=self.save_body(), headers=self.write_headers(**changes)), 403,
                )
        self.assertEqual(self.database.state()["revision"], 0)
        self.assertEqual(self.database.records()["total"], 1)

    def test_localhost_origin_must_match_localhost_host(self):
        response = self.request(
            "POST", "/api/save", body=self.save_body(),
            headers=self.write_headers(Host=f"localhost:{self.port}", Origin=f"http://localhost:{self.port}"),
        )
        self.assertEqual(response[0], 200)

    def test_valid_save_is_persistent_and_returns_authoritative_state(self):
        proposed = with_snapshot(self.initial)
        raw = {"typedCount": " 1.234e60 ", "config": " untrimmed configuration "}
        status, _, body = self.request(
            "POST", "/api/save", body=self.save_body(data=proposed, raw=raw), headers=self.write_headers(),
        )
        result = json.loads(body)
        self.assertEqual(status, 200, body)
        self.assertEqual(result, {"revision": 1, "data": proposed})
        self.assertEqual(self.open_database().state(), result)
        self.assertEqual(self.database.records()["records"][-1]["raw"], raw)

    def test_frontend_action_kinds_and_metadata_contract(self):
        kinds = ("estimates", "written-update", "milestone", "archive", "restore", "reorder", "roadmap")
        proposed = with_snapshot(self.initial)
        proposed["workloads"][0]["snapshots"][-1]["id"] = f"saved-{uuid.uuid4()}"
        proposed["workloads"][0]["snapshots"][-1]["context"].update(
            targetPhysicalQubits="1000000", targetWindow="Next planning sprint", targetConfig="Target v1",
        )
        raw_actions = []
        for revision, kind in enumerate(kinds):
            if kind == "written-update":
                update = copy.deepcopy(self.initial["updates"][0])
                update.update(
                    id=f"local-{uuid.uuid4()}", owner="Test operator", body="A written update with its original past date",
                    requestKind="Request", request="Review the supplied evidence", requestOwner="Review group",
                    requestWindow="", local=True, savedAt="2026-09-23T18:00:00Z", revisions=[],
                )
                proposed["updates"].append(update)
            elif kind == "milestone":
                milestone = copy.deepcopy(self.initial["milestones"][0])
                milestone.update(
                    id=f"local-{uuid.uuid4()}", scope="1a", targetCandidate="1a", window="",
                    owner="Test operator", local=True, savedAt="2026-09-23T18:00:00Z", revisions=[],
                )
                proposed["milestones"].append(milestone)
            elif kind in ("archive", "restore"):
                milestone = proposed["milestones"][-1]
                milestone["revisions"].append({key: value for key, value in milestone.items() if key != "revisions"})
                milestone["archived"] = kind == "archive"
            elif kind == "reorder":
                proposed["updates"].reverse()
            elif kind == "roadmap":
                stage = proposed["roadmap"][0]
                stage["revisions"].append({key: value for key, value in stage.items() if key != "revisions"})
                stage.update(status="In progress", owner="Test operator", note="Explicit scoped assessment, not assumed completion")
            raw = {"kind": kind, "draft": "  exact draft input\r\n", "counts": "9,007,199,254,740,993"}
            response = self.request(
                "POST", "/api/save",
                body={"baseRevision": revision, "data": proposed, "action": {"kind": kind, "raw": raw}},
                headers=self.write_headers(),
            )
            self.assertEqual(response[0], 200, response[2])
            self.assertEqual(json.loads(response[2]), {"revision": revision + 1, "data": proposed})
            raw_actions.append(raw)
        self.assertTrue(all(update["date"] == "2026-09-01" for update in proposed["updates"]))
        status, _, body = self.request("GET", "/api/records")
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(set(result), {"records", "total"})
        self.assertEqual(result["total"], len(kinds) + 1)
        self.assertEqual([record["kind"] for record in result["records"][1:]], list(kinds))
        self.assertEqual([record["raw"] for record in result["records"][1:]], raw_actions)
        for record in result["records"]:
            self.assertEqual(set(record), {"id", "kind", "savedAt", "raw"})
            self.assertRegex(record["savedAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
        _, _, body = self.request("GET", "/api/state")
        state = json.loads(body)
        self.assertEqual(set(state), {"revision", "data", "token", "storage"})
        self.assertEqual(state["token"], self.token)
        self.assertEqual(state["data"], proposed)

    def test_http_invalid_save_and_revision_conflict_are_never_success_shaped(self):
        proposed = with_snapshot(self.initial)
        proposed["workloads"][0]["snapshots"][-1]["metrics"]["physicalOps"] = 10.5
        self.assert_api_error(self.request(
            "POST", "/api/save", body=self.save_body(data=proposed), headers=self.write_headers(),
        ), 422)
        self.assertEqual(self.database.state()["revision"], 0)
        self.assertEqual(self.database.records()["total"], 1)
        self.assertEqual(self.request(
            "POST", "/api/save", body=self.save_body(), headers=self.write_headers(),
        )[0], 200)
        conflict = self.assert_api_error(self.request(
            "POST", "/api/save", body=self.save_body(), headers=self.write_headers(),
        ), 409)
        self.assertEqual(conflict["currentRevision"], 1)
        self.assertEqual(self.database.records()["total"], 2)

    def test_invalid_json_and_encodings_are_rejected(self):
        for body in (
            b'{"baseRevision":0,"baseRevision":1}',
            b'{"raw":NaN}', b'{"raw":Infinity}', b'{"raw":1e9999}', b'{"unclosed":',
            b"\xff", b'{"raw": "\\ud800"}', b'{"\\ud800": "invalid key"}',
        ):
            with self.subTest(body=body):
                response = self.request("POST", "/api/save", body=body, headers=self.write_headers())
                self.assertIn(response[0], (400, 422))
                self.assertIn("error", json.loads(response[2]))
        self.assertEqual(self.database.records()["total"], 1)

    def test_oversized_body_is_rejected_without_reading_it(self):
        self.assert_api_error(self.request(
            "POST", "/api/save", body=b"{}",
            headers=self.write_headers(**{"Content-Length": str(server.MAX_JSON_BYTES + 1)}),
        ), 413)
        self.assertEqual(self.database.records()["total"], 1)

    def test_transfer_encoding_and_wrong_content_type_are_rejected(self):
        self.assert_api_error(self.request(
            "POST", "/api/save", body=b"{}", headers=self.write_headers(**{"Transfer-Encoding": "chunked"}),
        ), 400)
        self.assert_api_error(self.request(
            "POST", "/api/save", body=self.save_body(), headers=self.write_headers(**{"Content-Type": "text/plain"}),
        ), 415)

    def test_excessively_nested_json_is_rejected(self):
        raw = "leaf"
        for _ in range(65):
            raw = [raw]
        self.assert_api_error(self.request(
            "POST", "/api/save", body=self.save_body(raw=raw), headers=self.write_headers(),
        ), 422)
        self.assertEqual(self.database.records()["total"], 1)

    def test_raw_records_pagination_is_bounded(self):
        for revision in range(3):
            self.database.save(revision, self.initial, {"kind": "input", "raw": {"sequence": revision}})
        status, _, body = self.request("GET", "/api/records?limit=2&offset=1")
        result = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(result["total"], 4)
        self.assertEqual([record["id"] for record in result["records"]], [2, 3])
        self.assertEqual(result["records"][0]["raw"], {"sequence": 0})
        for query in (
            "limit=201", "limit=0", "limit=-1", "offset=-1", "limit=word",
            "limit=1&limit=2", "offset=9223372036854775808", "unknown=1", "limit=", "offset=",
        ):
            with self.subTest(query=query):
                self.assert_api_error(self.request("GET", f"/api/records?{query}"), 400)

    def test_export_contains_current_state_and_all_raw_events_without_token(self):
        proposed = with_snapshot(self.initial)
        raw = {"exact": "000123", "private": "operator input"}
        accepted = self.database.save(0, proposed, {"kind": "estimate", "raw": raw})
        status, headers, body = self.request("GET", "/api/export")
        exported = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(exported["revision"], accepted["revision"])
        self.assertEqual(exported["data"], proposed)
        self.assertEqual(exported["total"], 2)
        self.assertEqual(exported["records"][0]["raw"], self.initial)
        self.assertEqual(exported["records"][1]["raw"], raw)
        self.assertNotIn("token", exported)
        self.assertIn("attachment;", headers["content-disposition"])
        self.assertIn(".json", headers["content-disposition"])

    def test_database_download_is_a_consistent_independently_readable_backup(self):
        proposed = with_snapshot(self.initial)
        expected = self.database.save(0, proposed, {"kind": "estimate", "raw": {"original": "000456"}})
        with self.database.connection() as writer:
            writer.execute("BEGIN IMMEDIATE")
            writer.execute("UPDATE state SET revision=999 WHERE id=1")
            status, headers, body = self.request("GET", "/api/database")
            writer.execute("ROLLBACK")
        self.assertEqual(status, 200, body[:100])
        self.assertTrue(body.startswith(b"SQLite format 3\x00"))
        self.assertIn("attachment;", headers["content-disposition"])
        downloaded = self.base / "private" / "downloaded.sqlite3"
        downloaded.write_bytes(body)
        with contextlib.closing(sqlite3.connect(downloaded)) as connection:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            revision, data = connection.execute("SELECT revision, data_json FROM state WHERE id=1").fetchone()
            self.assertEqual(revision, expected["revision"])
            self.assertEqual(json.loads(data), proposed)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM raw_events").fetchone()[0], 2)
            self.assertEqual(json.loads(connection.execute(
                "SELECT raw_json FROM raw_events ORDER BY id DESC LIMIT 1"
            ).fetchone()[0]), {"original": "000456"})

    def test_head_has_no_body_and_preflight_has_no_cors(self):
        status, headers, body = self.request("HEAD", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertGreater(int(headers["content-length"]), 0)
        self.assert_api_error(self.request("OPTIONS", "/api/save"), 405)
        self.assert_api_error(self.request("OPTIONS", "/api/save", headers={"Origin": "https://attacker.example"}), 403)

    def test_tokens_are_ephemeral_not_saved_to_database(self):
        other_server = server.LocalServer(self.database, 0, dashboard_directory=self.dashboard)
        try:
            self.assertNotEqual(other_server.token, self.token)
        finally:
            other_server.server_close()
        self.assertNotIn(self.token, json.dumps(self.database.export()))


class CLITests(unittest.TestCase):
    def run_cli(self, *arguments):
        return subprocess.run(
            [sys.executable, "-B", str(SERVER_PATH), *arguments],
            capture_output=True, text=True, timeout=10, check=False,
        )

    def test_help_explains_local_scope_and_api_requirements(self):
        result = self.run_cli("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        for expected in ("127.0.0.1", "--database", "--seed", "--port 0", "bound URL", "X-Resource-Token", "NOT shared-user"):
            self.assertIn(expected, result.stdout)

    def test_cli_refuses_relative_or_in_repository_databases(self):
        for value in ("relative.sqlite3", str(SERVER_PATH.parent / "forbidden.sqlite3")):
            with self.subTest(value=value):
                result = self.run_cli("--database", value)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Cannot start", result.stderr)
        self.assertFalse((SERVER_PATH.parent / "forbidden.sqlite3").exists())

    def test_cli_rejects_invalid_ports(self):
        for value in ("65536", "-1", "word", "1.5"):
            with self.subTest(value=value):
                result = self.run_cli("--port", value)
                self.assertEqual(result.returncode, 2)
                self.assertIn("port", result.stderr)


class RunningCLITests(FixtureCase):
    def test_real_cli_seeds_serves_saves_and_restarts_without_seed(self):
        copied_server = self.dashboard / "server.py"
        copied_server.write_bytes(SERVER_PATH.read_bytes())
        database_path = self.base / "private" / "cli.sqlite3"
        expected = self.initial

        def stop(process):
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()

        for restart in (False, True):
            seed = self.base / "missing-seed.json" if restart else self.seed
            process = subprocess.Popen(
                [
                    sys.executable, "-B", str(copied_server), "--database", str(database_path),
                    "--seed", str(seed), "--port", "0",
                ],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
            self.addCleanup(stop, process)
            lines = queue.Queue(maxsize=1)
            reader = threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True)
            reader.start()
            try:
                line = lines.get(timeout=10)
            except queue.Empty:
                self.fail("CLI did not print its bound URL")
            reader.join(timeout=5)
            match = re.fullmatch(r"Private local SQLite: http://127\.0\.0\.1:([0-9]+)/\s*", line)
            self.assertIsNotNone(match, line)
            port = int(match[1])
            self.assertGreater(port, 0)
            deadline = time.monotonic() + 10
            state = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    self.fail(f"CLI exited before serving: {process.stdout.read()}")
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=0.5)
                try:
                    connection.request("GET", "/api/state")
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    state = json.loads(response.read())
                    break
                except (OSError, http.client.HTTPException):
                    time.sleep(0.03)
                finally:
                    connection.close()
            self.assertIsNotNone(state, "CLI did not become responsive")
            self.assertEqual(state["data"], expected)
            self.assertEqual(state["revision"], 1 if restart else 0)
            if not restart:
                expected = with_snapshot(self.initial)
                body = json.dumps({
                    "baseRevision": 0, "data": expected,
                    "action": {"kind": "cli-estimate", "raw": {"typed": " 00123 "}},
                }).encode("utf-8")
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                try:
                    connection.request("POST", "/api/save", body=body, headers={
                        "Origin": f"http://127.0.0.1:{port}",
                        "X-Resource-Token": state["token"],
                        "Content-Type": "application/json",
                    })
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read())["revision"], 1)
                finally:
                    connection.close()
            stop(process)
        self.assertEqual(self.open_database(path=database_path).records()["total"], 2)


if __name__ == "__main__":
    unittest.main()
