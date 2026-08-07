#!/usr/bin/env python3
"""Derive and audit safe `geng` bounds for the rooted-block search class.

The class consists of C4-free 2-connected graphs on n vertices in which at
most one vertex has degree 2 and every other vertex has degree at least 3.
The program computes only necessary conditions, so using its bounds cannot
remove a genuine rooted-block counterexample.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class RootedBounds:
    order: int
    minimum_edges: int
    maximum_edges_pair_count: int
    maximum_degree: int
    ordinary_maximum_degree: int


def minimum_edges(order: int) -> int:
    """ceil((3n-1)/2), from one possible degree-2 root and n-1 degree-3 vertices."""
    if order < 3:
        raise ValueError("order must be at least 3")
    return (3 * order) // 2


def pair_count_allows(order: int, edges: int) -> bool:
    """Necessary C4-free inequality 4m^2 - 2mn <= n^2(n-1)."""
    if order < 1 or edges < 0:
        return False
    return 4 * edges * edges - 2 * edges * order <= order * order * (order - 1)


def maximum_edges_pair_count(order: int) -> int:
    if order < 1:
        raise ValueError("order must be positive")
    edges = 0
    while pair_count_allows(order, edges + 1):
        edges += 1
    return edges


def maximum_degree(order: int) -> int:
    """Safe C4-free rooted-class bound Delta <= floor(n/2)."""
    if order < 3:
        raise ValueError("order must be at least 3")
    return order // 2


def ordinary_maximum_degree(order: int) -> int:
    """Sharper bound when every vertex has degree at least 3."""
    if order < 3:
        raise ValueError("order must be at least 3")
    return (order - 1) // 2


def derive(order: int) -> RootedBounds:
    result = RootedBounds(
        order=order,
        minimum_edges=minimum_edges(order),
        maximum_edges_pair_count=maximum_edges_pair_count(order),
        maximum_degree=maximum_degree(order),
        ordinary_maximum_degree=ordinary_maximum_degree(order),
    )
    if result.minimum_edges > result.maximum_edges_pair_count:
        raise ValueError(f"necessary bounds make the rooted class empty at n={order}")
    return result


def audit(order: int) -> dict[str, object]:
    b = derive(order)
    checks = {
        "minimum_degree_sum": 2 * b.minimum_edges >= 3 * order - 1,
        "minimum_edges_is_least_integer":
            b.minimum_edges == 0 or 2 * (b.minimum_edges - 1) < 3 * order - 1,
        "maximum_edges_satisfies_pair_count":
            pair_count_allows(order, b.maximum_edges_pair_count),
        "next_edge_violates_pair_count":
            not pair_count_allows(order, b.maximum_edges_pair_count + 1),
        "rooted_degree_bound_integral": 2 * b.maximum_degree <= order,
        "next_rooted_degree_exceeds_order_bound":
            2 * (b.maximum_degree + 1) > order,
        "ordinary_degree_bound_integral":
            2 * b.ordinary_maximum_degree + 1 <= order,
        "next_ordinary_degree_exceeds_order_bound":
            2 * (b.ordinary_maximum_degree + 1) + 1 > order,
    }
    if not all(checks.values()):
        raise AssertionError({key: value for key, value in checks.items() if not value})
    return {
        "schema": "erdos64-rooted-geng-bounds-v1",
        "bounds": asdict(b),
        "checks": checks,
        "geng_fragment": (
            f"-C -d2 -f -D{b.maximum_degree} "
            f"{order} {b.minimum_edges}:{b.maximum_edges_pair_count}"
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("order", type=int)
    parser.add_argument("--expect-min-edges", type=int)
    parser.add_argument("--expect-max-edges", type=int)
    parser.add_argument("--expect-max-degree", type=int)
    args = parser.parse_args()
    result = audit(args.order)
    bounds = result["bounds"]
    expected = {
        "minimum_edges": args.expect_min_edges,
        "maximum_edges_pair_count": args.expect_max_edges,
        "maximum_degree": args.expect_max_degree,
    }
    mismatches = {
        key: {"actual": bounds[key], "expected": value}
        for key, value in expected.items()
        if value is not None and bounds[key] != value
    }
    if mismatches:
        raise SystemExit(json.dumps({"mismatches": mismatches}, sort_keys=True))
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
