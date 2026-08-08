#!/usr/bin/env python3
"""Fail-closed audit for one contiguous group of rooted-block residues."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any

COUNT_KEYS = (
    "generated_graphs",
    "rejected_min_degree_below_2",
    "rejected_multiple_degree_2_vertices",
    "rooted_admissible",
    "ordinary_min_degree3",
    "rooted_with_degree2_exception",
    "validated_c8_prefilter_hits",
    "exact_fallback_inputs",
    "exact_fallback_power_hits",
    "with_power_of_two_cycle",
    "power_free_candidates",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("base", type=int)
    parser.add_argument("last", type=int)
    parser.add_argument("modulus", type=int)
    parser.add_argument("commit")
    parser.add_argument("--order", type=int, required=True)
    parser.add_argument("--min-edges", type=int, required=True)
    parser.add_argument("--max-edges", type=int, required=True)
    parser.add_argument("--max-degree", type=int, required=True)
    return parser.parse_args()


def parse_run(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            result[key] = value
    return result


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def require_int(counts: dict[str, Any], key: str) -> int:
    value = counts.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"invalid count {key}={value!r}")
    return value


def main() -> int:
    args = parse_args()
    expected = list(range(args.base, args.last + 1))
    totals: Counter[str] = Counter()
    first_hits: Counter[str] = Counter()
    errors: list[dict[str, Any]] = []
    residues: list[int] = []
    elapsed = 0
    source_hashes: dict[str, set[str]] = {}

    for residue in expected:
        directory = args.root / f"residue-{residue:04d}-of-{args.modulus}"
        try:
            if not directory.is_dir():
                raise ValueError("missing residue directory")
            outer = int((directory / "outer-exit-code.txt").read_text().strip())
            if outer != 0:
                raise ValueError(f"outer exit code {outer}")

            run = parse_run(directory / "RUN.txt")
            required_zero = (
                "compile_exit_code",
                "bounds_exit_code",
                "geng_exit_code",
                "prefilter_exit_code",
                "tee_exit_code",
                "checker_exit_code",
                "combiner_exit_code",
                "pipeline_exit_code",
            )
            bad = {key: run.get(key) for key in required_zero if run.get(key) != "0"}
            if bad:
                raise ValueError(f"nonzero stage exit codes: {bad}")

            expected_fields = {
                "source_commit": args.commit,
                "order": str(args.order),
                "min_edges": str(args.min_edges),
                "max_edges": str(args.max_edges),
                "max_degree": str(args.max_degree),
                "residue": str(residue),
                "modulus": str(args.modulus),
                "survivor_count": "0",
                "candidate_count": "0",
            }
            wrong = {
                key: (run.get(key), value)
                for key, value in expected_fields.items()
                if run.get(key) != value
            }
            if wrong:
                raise ValueError(f"RUN field mismatch: {wrong}")

            manifest = directory / "SHA256SUMS.txt"
            listed = 0
            for line in manifest.read_text(encoding="utf-8").splitlines():
                digest, name = line.split("  ", 1)
                target = directory / name
                if not target.is_file() or sha256_file(target) != digest:
                    raise ValueError(f"manifest mismatch for {name}")
                listed += 1
            if listed == 0:
                raise ValueError("empty per-residue manifest")

            summary = json.loads((directory / "combined-summary.json").read_text())
            if summary.get("schema") != "erdos64-rooted-fast-shard-v1":
                raise ValueError("unexpected combined-summary schema")
            if summary.get("order") != args.order:
                raise ValueError("wrong order in combined summary")
            if not all(summary.get("checks", {}).values()):
                raise ValueError("a combined-summary consistency check is false")

            counts = summary.get("counts", {})
            for key in COUNT_KEYS:
                totals[key] += require_int(counts, key)
            if counts["power_free_candidates"] != 0:
                raise ValueError("counterexample candidate emitted")
            if counts["exact_fallback_inputs"] != 0:
                raise ValueError("unexpected exact fallback input")
            if counts["rooted_admissible"] != counts["with_power_of_two_cycle"]:
                raise ValueError("rooted cycle partition mismatch")

            histogram = summary.get("first_hit_histogram", {})
            if set(histogram) - {"8"}:
                raise ValueError("a first-hit length other than 8 appeared")
            for key, value in histogram.items():
                first_hits[str(key)] += int(value)

            for key in (
                "rooted_block_exact_sha256",
                "rooted_prefilter_source_sha256",
                "rooted_bounds_sha256",
                "combiner_sha256",
            ):
                source_hashes.setdefault(key, set()).add(run[key])
            elapsed += int(run["elapsed_seconds"])
            residues.append(residue)
        except Exception as exc:  # fail closed but retain a complete audit report
            errors.append({"residue": residue, "error": str(exc)})

    checks = {
        "all_expected_residues": residues == expected,
        "no_errors": not errors,
        "no_candidates": totals["power_free_candidates"] == 0,
        "no_fallback_inputs": totals["exact_fallback_inputs"] == 0,
        "all_rooted_have_validated_c8": (
            totals["rooted_admissible"] == totals["validated_c8_prefilter_hits"]
        ),
        "rooted_degree_partition": (
            totals["rooted_admissible"]
            == totals["ordinary_min_degree3"]
            + totals["rooted_with_degree2_exception"]
        ),
        "first_hit_partition": (
            sum(first_hits.values()) == totals["with_power_of_two_cycle"]
        ),
        "source_hashes_constant": all(
            len(values) == 1 for values in source_hashes.values()
        ),
    }
    result = {
        "schema": "erdos64-rooted-group-v2",
        "workflow_commit": args.commit,
        "order": args.order,
        "modulus": args.modulus,
        "base_residue": args.base,
        "last_residue": args.last,
        "residues": residues,
        "counts": dict(totals),
        "first_hit_histogram": dict(sorted(first_hits.items())),
        "sum_elapsed_seconds": elapsed,
        "source_hashes": {
            key: sorted(values) for key, values in source_hashes.items()
        },
        "checks": checks,
        "errors": errors,
        "counterexample_found": totals["power_free_candidates"] > 0,
    }
    (args.root / "job-summary.json").write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    lines = []
    for path in sorted(args.root.rglob("*")):
        if not path.is_file() or path.name == "JOB_SHA256SUMS.txt":
            continue
        lines.append(f"{sha256_file(path)}  {path.relative_to(args.root)}")
    (args.root / "JOB_SHA256SUMS.txt").write_text(
        "\n".join(lines) + "\n", encoding="utf-8"
    )

    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
