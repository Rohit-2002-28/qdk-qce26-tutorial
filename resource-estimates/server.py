"""Private, single-computer storage for the standalone resource-estimate dashboard.

Python 3.13 standard library only. Run:
    python resource-estimates\\server.py --database C:\\private\\estimates.sqlite3
Use --port 0 to select an available loopback port. The first stdout line prints
the actual bound URL; the default port remains 8765.

Only 127.0.0.1 is bound. This is a local user workspace, NOT shared-user
authentication or an Internet service. Other processes running as your user can
read the database and obtain the server's CSRF token. Do not publish, proxy,
tunnel, or copy the database into the repository or a web-served directory.
GitHub Pages continues to serve only the standalone, static dashboard.

The default database is in LOCALAPPDATA/ResourceEstimates on Windows, or
XDG_STATE_HOME/ResourceEstimates (otherwise ~/.local/state/ResourceEstimates).
The seed is imported once, together with its original JSON. Normal restarts
never reread or overwrite it. All accepted submissions, including their exact
UTF-8 request text and action.raw JSON, are retained in an append-only table.
For SQL inspection, raw_events.raw_json holds each raw action (the whole seed
for seed-import); raw_events.submission_json holds the original input text.
Normalized counts remain exact JSON strings in state.data_json. SQLite's JSON
queries return these counts as TEXT, without integer or floating-point casts:
    SELECT json_extract(w.value, '$.id') AS workload_id,
           json_extract(s.value, '$.id') AS snapshot_id, m.key, m.value
    FROM state, json_each(data_json, '$.workloads') AS w,
         json_each(w.value, '$.snapshots') AS s,
         json_each(s.value, '$.metrics') AS m;

GET /api/state supplies the current revision and this server's CSRF token.
POST /api/save requires application/json, X-Resource-Token, and an Origin equal
to http://<Host>, including the listening port (also required for command-line
clients). Send {baseRevision, data, action: {kind, raw}}. Success returns
{revision, data}; errors return {error, code}, never a success-shaped object.
Snapshots are immutable; add a new snapshot ID to correct an estimate. Written
record IDs must remain present (archive instead), and existing revisions are
append-only. Newly supplied/edited content requires an owner; new snapshots also
require an estimate date, configuration, caveat, reason (the change note), and
source. Target values require targetWindow and targetConfig, not a calendar
target date. Runtime hours are nonnegative decimal strings; ranges must contain
the supplied runtime and have a timing model. Request windows are optional
planning labels. An active linked milestone uses its workload's latest target
by estimate date/revision; archive or unlink it before removing that target.
Otherwise, a milestone needs its own planning window. Archiving alone
does not require inventing missing historical attribution.
There is no reset or delete endpoint. Reloading discards unsaved client edits,
not persisted estimates, written history, or raw events.

GET /api/records?limit=50&offset=0 inspects raw actions (limit 1..200).
GET /api/export downloads the state and every raw action.
GET /api/database downloads a consistent SQLite backup, not a live WAL file.
Downloads include private inputs and are assembled in memory. JSON requests and
seeds are limited to 8 MiB, nesting to 64 levels, and integer count strings to
4,096 digits. Counts are never converted to floating point. Only index.html is
served, at / and /resource-estimates/; there is no general file server.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import datetime as dt
import hmac
import http.server
import json
import math
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import sys
import threading
from decimal import Decimal
from typing import Any
from urllib.parse import parse_qs, urlsplit


DASHBOARD_DIRECTORY = Path(__file__).resolve().parent
METRIC_KEYS = (
    "logicalOps", "physicalOps", "nonClifford", "clifford1", "clifford2",
    "logicalQubits", "physicalQubits",
)
WORKLOAD_IDS = ("1a", "1b", "2", "3a", "3b", "4a", "4b", "4c")
ROADMAP_IDS = ("specification", "qubits", "operations", "correctness", "hardware")
MATURITIES = ("Unspecified", "Provisional", "Reviewed")
MILESTONE_STATUSES = ("Planned", "In progress", "Blocked", "Exploratory", "Done")
ROADMAP_STATUSES = ("Evidence supplied", "Not assessed", "In progress", "Blocked", "Complete")
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_RECORDS = 10_000
MAX_COUNT_DIGITS = 4096
MAX_WINDOW_LENGTH = 120
APPLICATION_ID = 0x52455354
DATABASE_VERSION = 1
STORAGE_LABEL = {"kind": "sqlite", "label": "Private local SQLite"}


class APIError(Exception):
    def __init__(self, status: int, code: str, message: str, **details: Any):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details

    def payload(self) -> dict[str, Any]:
        return {"error": str(self), "code": self.code, **self.details}


def invalid(path: str, message: str) -> None:
    raise APIError(422, "invalid_state", f"{path}: {message}")


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def same_json(left: Any, right: Any) -> bool:
    return json.dumps(left, sort_keys=True, ensure_ascii=False, allow_nan=False) == json.dumps(
        right, sort_keys=True, ensure_ascii=False, allow_nan=False
    )


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON object keys are not allowed.")
        result[key] = value
    return result


def _finite_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Non-finite JSON numbers are not allowed.")
    return number


def _reject_constant(value: str) -> None:
    raise ValueError(f"{value} is not a JSON number.")


JSON_DECODER = json.JSONDecoder(
    object_pairs_hook=_unique_object, parse_float=_finite_float,
    parse_constant=_reject_constant,
)


def parse_json(text: str) -> Any:
    try:
        value = JSON_DECODER.decode(text)
        validate_json_tree(value)
        return value
    except (ValueError, RecursionError) as error:
        raise APIError(400, "invalid_json", "Supply valid, finite UTF-8 JSON without duplicate keys.") from error


def validate_json_tree(value: Any) -> None:
    pending = [(value, 0)]
    count = 0
    while pending:
        node, depth = pending.pop()
        count += 1
        if depth > 64 or count > 200_000:
            invalid("JSON", "the document exceeds the nesting or item limit")
        if type(node) is dict:
            if not all(type(key) is str for key in node):
                invalid("JSON", "object keys must be strings")
            pending.extend((key, depth + 1) for key in node)
            pending.extend((child, depth + 1) for child in node.values())
        elif type(node) is list:
            pending.extend((child, depth + 1) for child in node)
        elif type(node) is str:
            if any(0xD800 <= ord(character) <= 0xDFFF for character in node):
                invalid("JSON", "unpaired Unicode surrogates are not allowed")
        elif type(node) not in (int, float, bool, type(None)):
            invalid("JSON", "unsupported value")
        elif type(node) is float and not math.isfinite(node):
            invalid("JSON", "numbers must be finite")


def member_json(text: str, wanted: str) -> str:
    """Slice an already validated object without reserializing its raw values."""
    position = text.index("{") + 1
    while True:
        while text[position].isspace():
            position += 1
        key, position = JSON_DECODER.raw_decode(text, position)
        while text[position].isspace():
            position += 1
        position += 1  # Colon in the already validated JSON object.
        while text[position].isspace():
            position += 1
        start = position
        _, position = JSON_DECODER.raw_decode(text, position)
        if key == wanted:
            return text[start:position]
        while text[position].isspace():
            position += 1
        if text[position] == "}":
            raise KeyError(wanted)
        position += 1


def object_value(value: Any, path: str) -> dict[str, Any]:
    if type(value) is not dict:
        invalid(path, "must be an object")
    return value


def array_value(value: Any, path: str, limit: int = MAX_RECORDS) -> list[Any]:
    if type(value) is not list or len(value) > limit:
        invalid(path, f"must be an array with at most {limit} entries")
    return value


def string_value(value: Any, path: str, *, required: bool = False, limit: int = 8000) -> str:
    if type(value) is not str or len(value) > limit:
        invalid(path, f"must be a string no longer than {limit} characters")
    if required and not value.strip():
        invalid(path, "must not be blank")
    if "\x00" in value:
        invalid(path, "must not contain NUL characters")
    return value


def integer_value(value: Any, path: str) -> int:
    if type(value) is not int or value < 0:
        invalid(path, "must be a nonnegative integer")
    return value


def boolean_value(value: Any, path: str) -> bool:
    if type(value) is not bool:
        invalid(path, "must be a boolean")
    return value


def enum_value(value: Any, options: tuple[str, ...] | set[str], path: str) -> str:
    if type(value) is not str or value not in options:
        invalid(path, "has an unsupported value")
    return value


def identifier(value: Any, path: str) -> str:
    string_value(value, path, required=True, limit=128)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]*", value):
        invalid(path, "must use letters, numbers, periods, underscores, colons, or hyphens")
    return value


def date_value(value: Any, path: str, *, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if type(value) is not str or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        invalid(path, "must be an ISO date (YYYY-MM-DD)")
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        invalid(path, "must be a real calendar date")


def timestamp_value(value: Any, path: str) -> None:
    if value is None:
        return
    if type(value) is not str or len(value) > 64 or "T" not in value:
        invalid(path, "must be an ISO timestamp with a timezone, or null")
    try:
        parsed = dt.datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            raise ValueError
    except ValueError:
        invalid(path, "must be an ISO timestamp with a timezone, or null")


def count_value(value: Any, path: str, *, optional: bool = False) -> None:
    if optional and value == "":
        return
    if type(value) is not str or not re.fullmatch(rf"[0-9]{{1,{MAX_COUNT_DIGITS}}}", value):
        invalid(path, f"must be an exact, nonnegative decimal integer string (up to {MAX_COUNT_DIGITS} digits)")


def runtime_value(value: Any, path: str) -> Decimal | None:
    string_value(value, path, limit=128)
    if not value:
        return None
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value):
        invalid(path, "must be a nonnegative decimal string or empty")
    return Decimal(value)


def validate_context(value: Any, path: str) -> None:
    context = object_value(value, path)
    count_value(context.get("targetPhysicalQubits"), f"{path}.targetPhysicalQubits", optional=True)
    string_value(context.get("targetWindow"), f"{path}.targetWindow", limit=MAX_WINDOW_LENGTH)
    for key in ("targetConfig", "timingModel", "gateBasis"):
        string_value(context.get(key), f"{path}.{key}")
    if context["targetPhysicalQubits"]:
        for key in ("targetWindow", "targetConfig"):
            string_value(context[key], f"{path}.{key}", required=True)
    runtime = {
        key: runtime_value(context.get(key), f"{path}.{key}")
        for key in ("runtimeHours", "runtimeLowHours", "runtimeHighHours")
    }
    hours, low, high = runtime["runtimeHours"], runtime["runtimeLowHours"], runtime["runtimeHighHours"]
    if hours is not None:
        string_value(context["timingModel"], f"{path}.timingModel", required=True)
    if (low is None) != (high is None):
        invalid(path, "runtimeLowHours and runtimeHighHours must be supplied together")
    if low is not None and high is not None and (hours is None or not low <= hours <= high):
        invalid(path, "runtimeHours must lie within the ordered runtimeLowHours/runtimeHighHours range")
    cadence = string_value(context.get("cadenceDays"), f"{path}.cadenceDays", limit=128)
    if cadence and (not re.fullmatch(r"[0-9]+", cadence) or not 1 <= int(cadence) <= 9007199254740991):
        invalid(f"{path}.cadenceDays", "must be a positive whole number of days within the safe integer range, or empty")
    if boolean_value(context.get("gateBasisConfirmed"), f"{path}.gateBasisConfirmed"):
        string_value(context.get("gateBasis"), f"{path}.gateBasis", required=True)


def latest_snapshot(workload: dict[str, Any]) -> dict[str, Any]:
    # Reverse first so equal date/revision ties select the last entry, as in the client.
    return max(
        reversed(workload["snapshots"]),
        key=lambda snapshot: (snapshot["asOf"] or "", snapshot["revision"]),
    )


def revision_list(record: dict[str, Any], path: str, *, optional: bool = False) -> list[Any]:
    revisions = array_value(record.get("revisions", [] if optional else None), f"{path}.revisions")
    for index, revision in enumerate(revisions):
        object_value(revision, f"{path}.revisions[{index}]")
    return revisions


def local_metadata(record: dict[str, Any], path: str, *, required: bool = False) -> None:
    if required or "local" in record:
        boolean_value(record.get("local"), f"{path}.local")
    if required and "savedAt" not in record:
        invalid(path, "savedAt is required (null for an unknown imported timestamp)")
    if "savedAt" in record:
        timestamp_value(record["savedAt"], f"{path}.savedAt")


def unique_records(values: Any, path: str, limit: int = MAX_RECORDS) -> dict[str, dict[str, Any]]:
    result = {}
    for index, entry in enumerate(array_value(values, path, limit)):
        record = object_value(entry, f"{path}[{index}]")
        record_id = identifier(record.get("id"), f"{path}[{index}].id")
        if record_id in result:
            invalid(path, f"duplicate ID {record_id}")
        result[record_id] = record
    return result


def validate_state(data: Any, previous: dict[str, Any] | None = None) -> None:
    validate_json_tree(data)
    state = object_value(data, "data")
    if type(state.get("schemaVersion")) is not int or state["schemaVersion"] != 2:
        invalid("schemaVersion", "must equal 2")
    for key in ("assumptions", "sources"):
        if type(state.get(key)) not in (dict, list):
            invalid(key, "must be a metadata object or array")

    systems = array_value(state.get("systems"), "systems", 4)
    system_ids = []
    for index, system in enumerate(systems):
        system = object_value(system, f"systems[{index}]")
        system_ids.append(integer_value(system.get("id"), f"systems[{index}].id"))
        string_value(system.get("name"), f"systems[{index}].name", required=True, limit=500)
    if sorted(system_ids) != [1, 2, 3, 4]:
        invalid("systems", "must contain exactly the IDs 1, 2, 3, and 4")

    fields = array_value(state.get("fields"), "fields", 7)
    field_keys = []
    for index, field in enumerate(fields):
        field = object_value(field, f"fields[{index}]")
        field_keys.append(enum_value(field.get("key"), METRIC_KEYS, f"fields[{index}].key"))
        for key in ("label", "short", "group"):
            string_value(field.get(key), f"fields[{index}].{key}", required=True, limit=500)
    if len(field_keys) != 7 or set(field_keys) != set(METRIC_KEYS):
        invalid("fields", "must contain all seven metric keys exactly once")

    workloads = unique_records(state.get("workloads"), "workloads", 8)
    if set(workloads) != set(WORKLOAD_IDS):
        invalid("workloads", "must contain exactly the eight supported workload IDs")
    snapshots = {}
    for workload_id, workload in workloads.items():
        path = f"workloads.{workload_id}"
        for key in ("name", "shortName"):
            string_value(workload.get(key), f"{path}.{key}", required=True, limit=500)
        if integer_value(workload.get("system"), f"{path}.system") not in system_ids:
            invalid(path, "system does not refer to an existing system")
        history = unique_records(workload.get("snapshots"), f"{path}.snapshots")
        if not history:
            invalid(path, "at least one snapshot is required")
        for snapshot_id, snapshot in history.items():
            path_snapshot = f"{path}.snapshots.{snapshot_id}"
            if snapshot_id in snapshots:
                invalid(path_snapshot, "snapshot IDs must be unique across workloads")
            snapshots[snapshot_id] = workload_id
            if "asOf" not in snapshot:
                invalid(path_snapshot, "asOf is required (null for an unknown imported date)")
            date_value(snapshot["asOf"], f"{path_snapshot}.asOf", nullable=True)
            integer_value(snapshot.get("revision"), f"{path_snapshot}.revision")
            metrics = object_value(snapshot.get("metrics"), f"{path_snapshot}.metrics")
            if set(metrics) != set(METRIC_KEYS):
                invalid(path_snapshot, "metrics must contain all seven metric keys, and no others")
            for key, value in metrics.items():
                count_value(value, f"{path_snapshot}.metrics.{key}")
            for key in ("config", "caveat", "reason", "source"):
                string_value(snapshot.get(key), f"{path_snapshot}.{key}")
            string_value(snapshot.get("owner"), f"{path_snapshot}.owner", limit=200)
            enum_value(snapshot.get("maturity"), MATURITIES, f"{path_snapshot}.maturity")
            local_metadata(snapshot, path_snapshot, required=True)
            validate_context(snapshot.get("context"), f"{path_snapshot}.context")

    scopes = {"all", *(f"system:{number}" for number in system_ids), *workloads}

    def check_target(scope: str, workload_id: str, path: str) -> None:
        if not workload_id:
            return
        if workload_id not in workloads:
            invalid(path, "must refer to an existing workload")
        if scope in workloads and scope != workload_id:
            invalid(path, "must belong to the selected workload scope")
        if scope.startswith("system:") and scope != f"system:{workloads[workload_id]['system']}":
            invalid(path, "must belong to the selected system scope")

    updates = unique_records(state.get("updates"), "updates")
    active = 0
    for record_id, record in updates.items():
        path = f"updates.{record_id}"
        scope = enum_value(record.get("scope"), scopes, f"{path}.scope")
        for key in ("title", "body"):
            string_value(record.get(key), f"{path}.{key}", required=True)
        date_value(record.get("date"), f"{path}.date")
        for key in ("owner", "requestOwner"):
            string_value(record.get(key), f"{path}.{key}", limit=200)
        string_value(record.get("request"), f"{path}.request")
        string_value(record.get("requestWindow"), f"{path}.requestWindow", limit=MAX_WINDOW_LENGTH)
        enum_value(record.get("requestKind"), ("", "Decision", "Blocker", "Request"), f"{path}.requestKind")
        snapshot_id = string_value(record.get("snapshotId"), f"{path}.snapshotId", limit=128)
        if snapshot_id:
            if snapshot_id not in snapshots:
                invalid(path, "snapshotId does not refer to an existing snapshot")
            check_target(scope, snapshots[snapshot_id], f"{path}.snapshotId")
        if not boolean_value(record.get("archived"), f"{path}.archived"):
            active += 1
        revision_list(record, path)
        local_metadata(record, path)
    if active > 4:
        invalid("updates", "at most four unarchived update bullets are allowed")

    milestones = unique_records(state.get("milestones"), "milestones")
    latest_contexts = {record_id: latest_snapshot(workload)["context"] for record_id, workload in workloads.items()}
    for record_id, record in milestones.items():
        path = f"milestones.{record_id}"
        scope = enum_value(record.get("scope"), scopes, f"{path}.scope")
        string_value(record.get("title"), f"{path}.title", required=True)
        string_value(record.get("outcome"), f"{path}.outcome")
        string_value(record.get("window"), f"{path}.window", limit=MAX_WINDOW_LENGTH)
        string_value(record.get("owner"), f"{path}.owner", limit=200)
        enum_value(record.get("status"), MILESTONE_STATUSES, f"{path}.status")
        dependencies = record.get("dependencies")
        if type(dependencies) is list:
            for index, dependency in enumerate(array_value(dependencies, f"{path}.dependencies", 100)):
                string_value(dependency, f"{path}.dependencies[{index}]", required=True, limit=1000)
        else:
            string_value(dependencies, f"{path}.dependencies")
        target = string_value(record.get("targetCandidate"), f"{path}.targetCandidate", limit=128)
        check_target(scope, target, f"{path}.targetCandidate")
        archived = boolean_value(record.get("archived"), f"{path}.archived")
        if target and not archived:
            if not all(latest_contexts[target][key].strip() for key in ("targetPhysicalQubits", "targetWindow", "targetConfig")):
                invalid(
                    f"{path}.targetCandidate",
                    "the latest target needs a value, targetWindow, and targetConfig; "
                    "archive or unlink the milestone before removing that target",
                )
        revision_list(record, path)
        local_metadata(record, path)

    roadmap = unique_records(state.get("roadmap"), "roadmap", 5)
    if set(roadmap) != set(ROADMAP_IDS):
        invalid("roadmap", "must contain exactly the five readiness records")
    for record_id, record in roadmap.items():
        path = f"roadmap.{record_id}"
        string_value(record.get("title"), f"{path}.title", required=True)
        enum_value(record.get("status"), ROADMAP_STATUSES, f"{path}.status")
        string_value(record.get("note"), f"{path}.note")
        string_value(record.get("owner"), f"{path}.owner", limit=200)
        string_value(record.get("window"), f"{path}.window", limit=MAX_WINDOW_LENGTH)
        revision_list(record, path, optional=True)
        local_metadata(record, path)

    if previous is not None:
        validate_history(previous, state)


def validate_history(previous: dict[str, Any], proposed: dict[str, Any]) -> None:
    old_workloads = {record["id"]: record for record in previous["workloads"]}
    for workload in proposed["workloads"]:
        path = f"workloads.{workload['id']}.snapshots"
        old = {snapshot["id"]: snapshot for snapshot in old_workloads[workload["id"]]["snapshots"]}
        new = {snapshot["id"]: snapshot for snapshot in workload["snapshots"]}
        for snapshot_id, snapshot in old.items():
            if snapshot_id not in new or not same_json(snapshot, new[snapshot_id]):
                invalid(path, f"snapshot {snapshot_id} is immutable; append a new snapshot ID instead")
        for snapshot_id in new.keys() - old.keys():
            snapshot = new[snapshot_id]
            date_value(snapshot["asOf"], f"{path}.{snapshot_id}.asOf")
            for key in ("owner", "config", "caveat", "reason", "source"):
                string_value(snapshot[key], f"{path}.{snapshot_id}.{key}", required=True)

    for collection in ("updates", "milestones", "roadmap"):
        old_records = {record["id"]: record for record in previous[collection]}
        new_records = {record["id"]: record for record in proposed[collection]}
        if old_records.keys() - new_records.keys():
            invalid(collection, "written record IDs cannot be dropped; archive records instead")
        for record_id, record in new_records.items():
            path = f"{collection}.{record_id}"
            old = old_records.get(record_id)
            old_revisions = old.get("revisions", []) if old else []
            revisions = record.get("revisions", [])
            if len(revisions) < len(old_revisions) or not same_json(
                old_revisions, revisions[:len(old_revisions)]
            ):
                invalid(path, "existing written revisions are immutable and cannot be dropped or reordered")
            ignored = {"revisions", "local", "savedAt", "archived"}
            content = {key: value for key, value in record.items() if key not in ignored}
            old_content = {key: value for key, value in old.items() if key not in ignored} if old else None
            if old is not None and same_json(content, old_content):
                continue
            string_value(record.get("owner"), f"{path}.owner", required=True, limit=200)
            if collection == "updates":
                if record["requestKind"]:
                    for key in ("request", "requestOwner"):
                        string_value(record[key], f"{path}.{key}", required=True)
                elif any(record[key].strip() for key in ("request", "requestOwner", "requestWindow")):
                    invalid(f"{path}.requestKind", "choose an action kind or clear the unused request fields")
            elif collection == "milestones":
                string_value(record["outcome"], f"{path}.outcome", required=True)
                if not record["targetCandidate"]:
                    string_value(record["window"], f"{path}.window", required=True)
            elif collection == "roadmap":
                string_value(record["note"], f"{path}.note", required=True)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def repository_directory(dashboard_directory: Path) -> Path:
    for directory in (dashboard_directory, *dashboard_directory.parents):
        if (directory / ".git").exists():
            return directory.resolve()
    return dashboard_directory.parent.resolve()


def default_database_path() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        configured = os.environ.get("XDG_STATE_HOME")
        base = Path(configured) if configured and Path(configured).is_absolute() else Path.home() / ".local" / "state"
    return base / "ResourceEstimates" / "resource-estimates.sqlite3"


class Database:
    def __init__(
        self, database_path: Path, seed_path: Path, *,
        dashboard_directory: Path = DASHBOARD_DIRECTORY, repository_root: Path | None = None,
    ):
        supplied_path = Path(database_path).expanduser()
        if not supplied_path.is_absolute():
            raise ValueError("--database must be an absolute path outside the repository.")
        self.path = supplied_path.resolve()
        dashboard_directory = Path(dashboard_directory).resolve()
        root = Path(repository_root).resolve() if repository_root else repository_directory(dashboard_directory)
        if any(self.path.is_relative_to(directory) for directory in (root, dashboard_directory)):
            raise ValueError("The database must be outside both the repository and the served directory.")
        if self.path.exists() and not self.path.is_file():
            raise ValueError("The database path must name a file.")
        self._lock = threading.RLock()
        self._initialize(Path(seed_path))

    @contextlib.contextmanager
    def connection(self):
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        try:
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA trusted_schema=OFF")
            yield connection
        finally:
            connection.close()

    def _existing(self, connection: sqlite3.Connection) -> bool:
        tables = connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        if not tables:
            return False
        if (
            connection.execute("PRAGMA application_id").fetchone()[0] != APPLICATION_ID
            or connection.execute("PRAGMA user_version").fetchone()[0] != DATABASE_VERSION
        ):
            raise ValueError("This is not a supported resource-estimates database.")
        row = connection.execute("SELECT revision, data_json FROM state WHERE id=1").fetchone()
        if row is None:
            raise ValueError("The existing database has no state; refusing to reseed it.")
        validate_state(parse_json(row[1]))
        return True

    def _initialize(self, seed_path: Path) -> None:
        if self.path.exists():
            with self.connection() as connection:
                if self._existing(connection):
                    return
        with seed_path.open("rb") as seed_file:
            seed_bytes = seed_file.read(MAX_JSON_BYTES + 1)
        if len(seed_bytes) > MAX_JSON_BYTES:
            raise ValueError("The seed exceeds the 8 MiB limit.")
        try:
            seed_text = seed_bytes.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError("The seed must be UTF-8 JSON.") from error
        seed = parse_json(seed_text)
        validate_state(seed)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600) if not self.path.exists() else None
        if descriptor is not None:
            os.close(descriptor)
        with self.connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("BEGIN IMMEDIATE")
            try:
                if self._existing(connection):
                    connection.execute("ROLLBACK")
                    return
                connection.execute(
                    "CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), "
                    "revision INTEGER NOT NULL CHECK(revision>=0), data_json TEXT NOT NULL, "
                    "updated_at TEXT NOT NULL)"
                )
                connection.execute(
                    "CREATE TABLE raw_events (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                    "kind TEXT NOT NULL, saved_at TEXT NOT NULL, revision INTEGER NOT NULL, "
                    "raw_json TEXT NOT NULL, submission_json TEXT NOT NULL)"
                )
                for operation in ("UPDATE", "DELETE"):
                    connection.execute(
                        f"CREATE TRIGGER raw_events_no_{operation.lower()} BEFORE {operation} ON raw_events "
                        "BEGIN SELECT RAISE(ABORT, 'raw_events is append-only'); END"
                    )
                connection.execute(f"PRAGMA application_id={APPLICATION_ID}")
                connection.execute(f"PRAGMA user_version={DATABASE_VERSION}")
                imported_at = utc_now()
                connection.execute("INSERT INTO state VALUES (1, 0, ?, ?)", (json_text(seed), imported_at))
                connection.execute(
                    "INSERT INTO raw_events (kind, saved_at, revision, raw_json, submission_json) "
                    "VALUES ('seed-import', ?, 0, ?, ?)", (imported_at, seed_text, seed_text),
                )
                connection.execute("COMMIT")
            except BaseException:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise

    def state(self) -> dict[str, Any]:
        with self._lock, self.connection() as connection:
            revision, data = connection.execute("SELECT revision, data_json FROM state WHERE id=1").fetchone()
            return {"revision": revision, "data": parse_json(data)}

    def save(
        self, base_revision: Any, data: Any, action: Any, *, submission_text: str | None = None,
    ) -> dict[str, Any]:
        integer_value(base_revision, "baseRevision")
        action = object_value(action, "action")
        kind = string_value(action.get("kind"), "action.kind", required=True, limit=120)
        if "raw" not in action:
            invalid("action.raw", "is required, even when its value is null")
        validate_json_tree(action)
        proposed = copy.deepcopy(data)
        with self._lock, self.connection() as connection:
            revision, previous_text = connection.execute(
                "SELECT revision, data_json FROM state WHERE id=1"
            ).fetchone()
            if base_revision != revision:
                raise APIError(409, "revision_conflict", "State changed; reload before saving.", currentRevision=revision)
            validate_state(proposed, parse_json(previous_text))
            state_text = json_text(proposed)
            if submission_text is None:
                submission_text = json_text({"baseRevision": base_revision, "data": proposed, "action": action})
            if len(submission_text.encode("utf-8")) > MAX_JSON_BYTES:
                raise APIError(413, "payload_too_large", "JSON submissions must not exceed 8 MiB.")
            raw_text = member_json(member_json(submission_text, "action"), "raw")
            saved_at = utc_now()
            connection.execute("BEGIN IMMEDIATE")
            try:
                current_revision = connection.execute("SELECT revision FROM state WHERE id=1").fetchone()[0]
                if current_revision != base_revision:
                    raise APIError(
                        409, "revision_conflict", "State changed; reload before saving.", currentRevision=current_revision,
                    )
                new_revision = current_revision + 1
                connection.execute(
                    "UPDATE state SET revision=?, data_json=?, updated_at=? WHERE id=1",
                    (new_revision, state_text, saved_at),
                )
                connection.execute(
                    "INSERT INTO raw_events (kind, saved_at, revision, raw_json, submission_json) VALUES (?, ?, ?, ?, ?)",
                    (kind, saved_at, new_revision, raw_text, submission_text),
                )
                connection.execute("COMMIT")
            except BaseException:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise
            return {"revision": new_revision, "data": proposed}

    @staticmethod
    def _records(rows: list[tuple[Any, ...]]) -> list[dict[str, Any]]:
        return [
            {"id": record_id, "kind": kind, "savedAt": saved_at, "raw": parse_json(raw)}
            for record_id, kind, saved_at, raw in rows
        ]

    def records(self, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        with self._lock, self.connection() as connection:
            connection.execute("BEGIN")
            total = connection.execute("SELECT COUNT(*) FROM raw_events").fetchone()[0]
            rows = connection.execute(
                "SELECT id, kind, saved_at, raw_json FROM raw_events ORDER BY id LIMIT ? OFFSET ?", (limit, offset),
            ).fetchall()
            return {"records": self._records(rows), "total": total}

    def export(self) -> dict[str, Any]:
        with self._lock, self.connection() as connection:
            connection.execute("BEGIN")
            revision, data = connection.execute("SELECT revision, data_json FROM state WHERE id=1").fetchone()
            rows = connection.execute("SELECT id, kind, saved_at, raw_json FROM raw_events ORDER BY id").fetchall()
            return {"revision": revision, "data": parse_json(data), "records": self._records(rows), "total": len(rows)}

    def backup(self) -> bytes:
        with self._lock, self.connection() as connection, contextlib.closing(sqlite3.connect(":memory:")) as target:
            connection.backup(target)
            return target.serialize()


class LocalServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 8

    def __init__(self, database: Database, port: int = 8765, *, dashboard_directory: Path = DASHBOARD_DIRECTORY):
        self.database = database
        self.dashboard_directory = Path(dashboard_directory).resolve()
        self.token = secrets.token_urlsafe(32)
        self._workers = threading.BoundedSemaphore(16)
        super().__init__(("127.0.0.1", port), RequestHandler)

    def process_request(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        self._workers.acquire()
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._workers.release()
            raise

    def process_request_thread(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._workers.release()


class RequestHandler(http.server.BaseHTTPRequestHandler):
    server: LocalServer
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        self.request.settimeout(10)
        super().setup()

    def version_string(self) -> str:
        return "ResourceEstimates"

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _send(self, status: int, body: bytes, content_type: str, *, filename: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
            "connect-src 'self'; img-src 'self' data:; font-src 'self' data:; "
            "base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
        )
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, value: Any, *, filename: str | None = None) -> None:
        self._send(status, json_text(value).encode("utf-8"), "application/json; charset=utf-8", filename=filename)

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        self._json(code, {"error": message or "Invalid HTTP request.", "code": "http_error"})

    def _header(self, name: str, *, required: bool = False) -> str | None:
        values = self.headers.get_all(name, [])
        if len(values) > 1 or (required and not values):
            raise APIError(403, "invalid_header", f"Exactly one {name} header is required.")
        return values[0].strip() if values else None

    def _check_access(self, *, write: bool) -> None:
        port = self.server.server_port
        host = self._header("Host", required=True).lower()
        if host not in (f"localhost:{port}", f"127.0.0.1:{port}"):
            raise APIError(403, "forbidden_host", "Host must be localhost or 127.0.0.1 with the listening port.")
        site = self._header("Sec-Fetch-Site")
        if site is not None and site.lower() not in ("same-origin", "none"):
            raise APIError(403, "cross_site_request", "Cross-site and cross-origin requests are not permitted.")
        origin = self._header("Origin", required=write)
        if origin is not None and origin.lower() != f"http://{host}":
            raise APIError(403, "forbidden_origin", "Origin must match this local server's Host and port.")
        if write:
            token = self._header("X-Resource-Token", required=True)
            try:
                valid_token = hmac.compare_digest(token, self.server.token)
            except TypeError:
                valid_token = False
            if not valid_token:
                raise APIError(403, "invalid_token", "A valid X-Resource-Token from /api/state is required.")

    def _body(self) -> tuple[dict[str, Any], str]:
        if self.headers.get_all("Transfer-Encoding"):
            raise APIError(400, "invalid_length", "Transfer-Encoding is not supported; send Content-Length.")
        length_text = self._header("Content-Length")
        if length_text is None:
            raise APIError(411, "length_required", "Content-Length is required.")
        if not re.fullmatch(r"[0-9]{1,10}", length_text):
            raise APIError(400, "invalid_length", "Content-Length must be a nonnegative integer.")
        length = int(length_text)
        if length > MAX_JSON_BYTES:
            raise APIError(413, "payload_too_large", "JSON submissions must not exceed 8 MiB.")
        self._header("Content-Type", required=True)
        if self.headers.get_content_type() != "application/json" or self.headers.get_content_charset("utf-8") != "utf-8":
            raise APIError(415, "unsupported_media_type", "Send application/json encoded as UTF-8.")
        try:
            body = self.rfile.read(length)
        except TimeoutError as error:
            raise APIError(408, "request_timeout", "The request body was not received in time.") from error
        if len(body) != length:
            raise APIError(400, "incomplete_body", "The body does not match Content-Length.")
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError as error:
            raise APIError(400, "invalid_json", "The request must contain UTF-8 JSON.") from error
        return object_value(parse_json(text), "request"), text

    def _dispatch(self, *, write: bool = False) -> None:
        try:
            self._check_access(write=write)
            target = urlsplit(self.path)
            if target.scheme or target.netloc or target.fragment or not self.path.startswith("/"):
                raise APIError(400, "invalid_path", "Use a local, absolute request path.")
            path = target.path
            if write:
                if path != "/api/save" or target.query:
                    raise APIError(404, "not_found", "No such endpoint.")
                body, text = self._body()
                result = self.server.database.save(
                    body.get("baseRevision"), body.get("data"), body.get("action"), submission_text=text,
                )
                self._json(200, result)
            elif path in ("/", "/resource-estimates/"):
                artifact = self.server.dashboard_directory / "index.html"
                if artifact.is_symlink() or not artifact.is_file():
                    raise APIError(503, "dashboard_unavailable", "Build the standalone dashboard index.html first.")
                with artifact.open("rb") as html_file:
                    html = html_file.read(16 * 1024 * 1024 + 1)
                if len(html) > 16 * 1024 * 1024:
                    raise APIError(503, "dashboard_unavailable", "The dashboard artifact exceeds the 16 MiB limit.")
                self._send(200, html, "text/html; charset=utf-8")
            elif path == "/api/records":
                try:
                    query = parse_qs(target.query, keep_blank_values=True, strict_parsing=True, max_num_fields=2)
                    if set(query) - {"limit", "offset"} or any(len(values) != 1 for values in query.values()):
                        raise ValueError
                    limit_text, offset_text = query.get("limit", ["50"])[0], query.get("offset", ["0"])[0]
                    if not re.fullmatch(r"[0-9]{1,3}", limit_text) or not re.fullmatch(r"[0-9]{1,19}", offset_text):
                        raise ValueError
                    limit, offset = int(limit_text), int(offset_text)
                    if not 1 <= limit <= 200 or offset > 2**63 - 1:
                        raise ValueError
                except ValueError as error:
                    raise APIError(400, "invalid_pagination", "Use limit 1..200 and a nonnegative offset.") from error
                self._json(200, self.server.database.records(limit, offset))
            elif target.query:
                raise APIError(400, "invalid_query", "This endpoint does not accept query parameters.")
            elif path == "/api/state":
                self._json(200, {**self.server.database.state(), "token": self.server.token, "storage": STORAGE_LABEL})
            elif path == "/api/export":
                self._json(200, self.server.database.export(), filename="resource-estimates-export.json")
            elif path == "/api/database":
                self._send(
                    200, self.server.database.backup(), "application/vnd.sqlite3", filename="resource-estimates.sqlite3",
                )
            else:
                raise APIError(404, "not_found", "No such endpoint.")
        except APIError as error:
            self._json(error.status, error.payload())
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except sqlite3.Error:
            self._json(503, {"error": "The private database is unavailable; no save was acknowledged.", "code": "database_error"})
        except (OSError, ValueError, RecursionError):
            self._json(500, {"error": "The request could not be completed.", "code": "server_error"})

    def do_GET(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch(write=True)

    def do_OPTIONS(self) -> None:
        try:
            self._check_access(write=False)
            self._json(405, {"error": "Cross-origin access and preflight are not supported.", "code": "method_not_allowed"})
        except APIError as error:
            self._json(error.status, error.payload())


def port_number(value: str) -> int:
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("port must be an integer from 0 to 65535") from error
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be an integer from 0 to 65535")
    return port


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database", type=Path, default=default_database_path(), help="absolute private SQLite path outside the repository")
    parser.add_argument("--seed", type=Path, default=DASHBOARD_DIRECTORY / "src" / "data.json", help="initial state JSON; read only for a new database")
    parser.add_argument("--port", type=port_number, default=8765, help="loopback port; 0 selects an available port (default: 8765)")
    args = parser.parse_args(argv)
    try:
        database = Database(args.database, args.seed)
        with LocalServer(database, args.port) as server:
            print(f"Private local SQLite: http://127.0.0.1:{server.server_port}/", flush=True)
            print(f"Database: {database.path}", flush=True)
            print("Loopback only; not multi-user authentication. Press Ctrl+C to stop.", flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
    except (APIError, OSError, ValueError, sqlite3.Error) as error:
        print(f"Cannot start the private local server: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
