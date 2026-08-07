#!/usr/bin/env python3
"""Validate and combine fast-prefilter and exact-fallback rooted search counts."""

from __future__ import annotations

import argparse
import json
import pathlib
from collections import Counter
from typing import Any


def nonnegative_integer(mapping: dict[str, Any], key: str) -> int:
    value = mapping.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{key} must be a nonnegative integer, got {value!r}")
    return value


def integer_histogram(mapping: dict[str, Any], key: str) -> Counter[str]:
    value = mapping.get(key, {})
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be an object")
    result: Counter[str] = Counter()
    for name, count in value.items():
        if not isinstance(name, str):
            raise ValueError(f"{key} has a non-string key")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise ValueError(f"{key}[{name!r}] is not a nonnegative integer")
        result[name] += count
    return result


def combine(prefilter: dict[str, Any], exact: dict[str, Any]) -> dict[str, Any]:
    if prefilter.get("schema") != "erdos64-rooted-prefilter-v1":
        raise ValueError("unexpected prefilter schema")
    if exact.get("algorithms") != [
        "held-karp-subset-dp",
        "root-neighbour-path-bnb",
    ]:
        raise ValueError("unexpected exact-checker algorithm list")
    if exact.get("dual_parser_agreement") is not True:
        raise ValueError("exact checker did not record dual parser agreement")
    if exact.get("fail_closed") is not True:
        raise ValueError("exact checker did not record fail-closed operation")

    order = nonnegative_integer(prefilter, "order")
    if exact.get("order") != order:
        raise ValueError("prefilter and exact-checker orders differ")

    generated = nonnegative_integer(prefilter, "input_graphs")
    roundtripped = nonnegative_integer(prefilter, "graph6_roundtrip_verified")
    rejected_low_degree = nonnegative_integer(
        prefilter, "rejected_min_degree_below_2"
    )
    rejected_many_roots = nonnegative_integer(
        prefilter, "rejected_multiple_degree_2_vertices"
    )
    rooted = nonnegative_integer(prefilter, "rooted_admissible")
    ordinary = nonnegative_integer(prefilter, "ordinary_min_degree_3")
    exceptional = nonnegative_integer(
        prefilter, "rooted_with_degree_2_exception"
    )
    validated_c8 = nonnegative_integer(
        prefilter, "with_validated_c8_witness"
    )
    survivors = nonnegative_integer(
        prefilter, "survivors_without_c8_witness"
    )
    malformed = nonnegative_integer(prefilter, "malformed_records")
    invalid_witnesses = nonnegative_integer(prefilter, "invalid_witnesses")

    exact_input = nonnegative_integer(exact, "input_graphs")
    exact_rooted = nonnegative_integer(exact, "rooted_admissible")
    exact_power = nonnegative_integer(exact, "with_power_of_two_cycle")
    candidates = nonnegative_integer(exact, "power_free_candidates")
    exact_rejections = integer_histogram(exact, "rejection_histogram")
    first_hits = integer_histogram(exact, "first_hit_histogram")

    checks = {
        "all_graph6_records_roundtripped": roundtripped == generated,
        "no_malformed_records": malformed == 0,
        "no_invalid_c8_witnesses": invalid_witnesses == 0,
        "prefilter_input_partition": (
            generated == rejected_low_degree + rejected_many_roots + rooted
        ),
        "rooted_degree_partition": rooted == ordinary + exceptional,
        "prefilter_cycle_partition": rooted == validated_c8 + survivors,
        "fallback_received_all_prefilter_survivors": exact_input == survivors,
        "fallback_rejected_no_prefilter_survivor": sum(exact_rejections.values()) == 0,
        "fallback_classified_every_input_as_rooted": exact_rooted == exact_input,
        "fallback_cycle_partition": exact_rooted == exact_power + candidates,
        "fallback_first_hit_partition": sum(first_hits.values()) == exact_power,
    }
    failed = [name for name, okay in checks.items() if not okay]
    if failed:
        raise ValueError("summary consistency checks failed: " + ", ".join(failed))

    first_hits["8"] += validated_c8
    total_with_power = validated_c8 + exact_power
    result = {
        "schema": "erdos64-rooted-fast-shard-v1",
        "order": order,
        "algorithms": {
            "prefilter": "validated-explicit-C8-witness",
            "fallback": exact["algorithms"],
        },
        "counts": {
            "generated_graphs": generated,
            "rejected_min_degree_below_2": rejected_low_degree,
            "rejected_multiple_degree_2_vertices": rejected_many_roots,
            "rooted_admissible": rooted,
            "ordinary_min_degree3": ordinary,
            "rooted_with_degree2_exception": exceptional,
            "validated_c8_prefilter_hits": validated_c8,
            "exact_fallback_inputs": exact_input,
            "exact_fallback_power_hits": exact_power,
            "with_power_of_two_cycle": total_with_power,
            "power_free_candidates": candidates,
        },
        "first_hit_histogram": dict(sorted(first_hits.items())),
        "checks": checks,
        "counterexample_found": candidates > 0,
    }
    if rooted != total_with_power + candidates:
        raise AssertionError("combined rooted cycle partition failed")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefilter", type=pathlib.Path, required=True)
    parser.add_argument("--exact", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    arguments = parser.parse_args()

    prefilter = json.loads(arguments.prefilter.read_text())
    exact = json.loads(arguments.exact.read_text())
    result = combine(prefilter, exact)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
