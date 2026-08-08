#!/usr/bin/env python3
"""Cross-audit a complete set of contiguous rooted-block group summaries."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("commit")
    parser.add_argument("--order", type=int, required=True)
    parser.add_argument("--modulus", type=int, required=True)
    parser.add_argument("--start", type=int, required=True)
    parser.add_argument("--end", type=int, required=True)
    parser.add_argument("--groups", type=int, required=True)
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    args = parse_args()
    summaries = sorted(args.root.rglob("job-summary.json"))
    expected_residues = list(range(args.start, args.end + 1))
    counts: Counter[str] = Counter()
    first_hits: Counter[str] = Counter()
    residues: list[int] = []
    elapsed = 0
    errors: list[dict[str, Any]] = []
    source_hashes: dict[str, set[str]] = {}
    group_ranges: list[tuple[int, int]] = []

    for path in summaries:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("schema") != "erdos64-rooted-group-v2":
                raise ValueError("unexpected group schema")
            if data.get("workflow_commit") != args.commit:
                raise ValueError("workflow commit mismatch")
            if data.get("order") != args.order:
                raise ValueError("order mismatch")
            if data.get("modulus") != args.modulus:
                raise ValueError("modulus mismatch")
            if not all(data.get("checks", {}).values()):
                raise ValueError("group check is false")
            if data.get("errors"):
                raise ValueError("group contains errors")
            if data.get("counterexample_found"):
                raise ValueError("group reports a counterexample candidate")

            group_residues = data["residues"]
            if group_residues != list(
                range(data["base_residue"], data["last_residue"] + 1)
            ):
                raise ValueError("group residue interval is not exact")
            residues.extend(group_residues)
            group_ranges.append((data["base_residue"], data["last_residue"]))
            counts.update(data["counts"])
            first_hits.update(data["first_hit_histogram"])
            elapsed += int(data["sum_elapsed_seconds"])
            for key, values in data.get("source_hashes", {}).items():
                source_hashes.setdefault(key, set()).update(values)
        except Exception as exc:
            errors.append({"path": str(path), "error": str(exc)})

    residues_sorted = sorted(residues)
    checks = {
        "all_group_summaries": len(summaries) == args.groups,
        "all_residues_exactly_once": residues_sorted == expected_residues,
        "no_duplicate_residues": len(residues) == len(set(residues)),
        "group_ranges_nonoverlapping": len(group_ranges) == len(set(group_ranges)),
        "no_group_errors": not errors,
        "no_candidates": counts["power_free_candidates"] == 0,
        "no_fallback_inputs": counts["exact_fallback_inputs"] == 0,
        "all_rooted_have_validated_c8": (
            counts["rooted_admissible"] == counts["validated_c8_prefilter_hits"]
        ),
        "all_first_hits_are_8": set(first_hits) <= {"8"},
        "first_hit_partition": (
            sum(first_hits.values()) == counts["with_power_of_two_cycle"]
        ),
        "rooted_cycle_partition": (
            counts["rooted_admissible"]
            == counts["with_power_of_two_cycle"]
            + counts["power_free_candidates"]
        ),
        "rooted_degree_partition": (
            counts["rooted_admissible"]
            == counts["ordinary_min_degree3"]
            + counts["rooted_with_degree2_exception"]
        ),
        "source_hashes_constant": all(
            len(values) == 1 for values in source_hashes.values()
        ),
    }
    result = {
        "schema": "erdos64-rooted-aggregate-v2",
        "workflow_commit": args.commit,
        "order": args.order,
        "modulus": args.modulus,
        "residue_range": f"{args.start}-{args.end}",
        "residues_verified": len(residues_sorted),
        "residues": residues_sorted,
        "group_ranges": sorted(group_ranges),
        "counts": dict(counts),
        "first_hit_histogram": dict(sorted(first_hits.items())),
        "sum_elapsed_seconds": elapsed,
        "source_hashes": {
            key: sorted(values) for key, values in source_hashes.items()
        },
        "checks": checks,
        "errors": errors,
        "counterexample_found": counts["power_free_candidates"] > 0,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (args.output.parent / "RUN.txt").write_text(
        f"repository_commit={args.commit}\naggregate_exit_code="
        f"{0 if all(checks.values()) else 1}\n",
        encoding="utf-8",
    )
    (args.output.parent / "SHA256SUMS.txt").write_text(
        f"{sha256_file(args.output)}  {args.output.name}\n"
        f"{sha256_file(args.output.parent / 'RUN.txt')}  RUN.txt\n",
        encoding="utf-8",
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
