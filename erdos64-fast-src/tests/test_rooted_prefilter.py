#!/usr/bin/env python3
from __future__ import annotations

import argparse
import itertools
import json
import os
import pathlib
import random
import subprocess
import sys
import tempfile
from collections.abc import Iterable

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "search"))

import rooted_block_exact as exact


def empty(n: int) -> list[int]:
    return [0] * n


def add_edge(graph: list[int], u: int, v: int) -> None:
    graph[u] |= 1 << v
    graph[v] |= 1 << u


def from_mask(n: int, mask: int) -> tuple[int, ...]:
    graph = empty(n)
    bit = 0
    for high in range(1, n):
        for low in range(high):
            if mask & (1 << bit):
                add_edge(graph, low, high)
            bit += 1
    return tuple(graph)


def complete_on(parts: Iterable[Iterable[int]], n: int) -> tuple[int, ...]:
    graph = empty(n)
    for part in parts:
        vertices = list(part)
        for index, u in enumerate(vertices):
            for v in vertices[index + 1 :]:
                add_edge(graph, u, v)
    return tuple(graph)


def cycle_plus_opposites(ordering: tuple[int, ...]) -> tuple[int, ...]:
    if len(ordering) != 8:
        raise ValueError("the construction needs eight vertices")
    graph = empty(8)
    for index in range(8):
        add_edge(graph, ordering[index], ordering[(index + 1) % 8])
    for index in range(4):
        add_edge(graph, ordering[index], ordering[index + 4])
    return tuple(graph)


def expected_survivor(graph: tuple[int, ...]) -> bool:
    degrees = [row.bit_count() for row in graph]
    if min(degrees, default=0) < 2:
        return False
    if sum(degree == 2 for degree in degrees) > 1:
        return False
    return not exact.has_cycle_dp(graph, 8)


def run_filter(
    binary: pathlib.Path,
    order: int,
    graphs: list[tuple[int, ...]],
) -> tuple[list[str], dict[str, int]]:
    records = [exact.encode_graph6(graph) for graph in graphs]
    with tempfile.TemporaryDirectory() as temporary:
        summary = pathlib.Path(temporary) / "summary.json"
        environment = dict(os.environ)
        environment.setdefault("ASAN_OPTIONS", "detect_leaks=0:halt_on_error=1")
        process = subprocess.run(
            [str(binary), "--order", str(order), "--summary", str(summary)],
            input=("\n".join(records) + ("\n" if records else "")).encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            check=False,
        )
        if process.returncode != 0:
            raise AssertionError(
                f"{binary.name} failed n={order} rc={process.returncode}\n"
                + process.stderr.decode(errors="replace")
            )
        result = json.loads(summary.read_text())
        output = process.stdout.decode().splitlines()
        expected = [
            record
            for record, graph in zip(records, graphs, strict=True)
            if expected_survivor(graph)
        ]
        if output != expected:
            for index, pair in enumerate(itertools.zip_longest(output, expected)):
                if pair[0] != pair[1]:
                    raise AssertionError(
                        f"{binary.name} output mismatch n={order} at {index}: "
                        f"actual={pair[0]!r} expected={pair[1]!r}"
                    )

        rooted = sum(
            min((row.bit_count() for row in graph), default=0) >= 2
            and sum(row.bit_count() == 2 for row in graph) <= 1
            for graph in graphs
        )
        with_c8 = sum(
            min((row.bit_count() for row in graph), default=0) >= 2
            and sum(row.bit_count() == 2 for row in graph) <= 1
            and exact.has_cycle_dp(graph, 8)
            for graph in graphs
        )
        checks = {
            "input_graphs": len(graphs),
            "graph6_roundtrip_verified": len(graphs),
            "rooted_admissible": rooted,
            "with_validated_c8_witness": with_c8,
            "survivors_without_c8_witness": len(expected),
            "malformed_records": 0,
            "invalid_witnesses": 0,
        }
        for key, value in checks.items():
            if result[key] != value:
                raise AssertionError(
                    f"{binary.name} summary {key}: {result[key]} != {value}"
                )
        return output, result


def all_cycle_ladders() -> list[tuple[int, ...]]:
    graphs: set[tuple[int, ...]] = set()
    for tail in itertools.permutations(range(1, 8)):
        if tail[0] > tail[-1]:
            continue
        graphs.add(cycle_plus_opposites((0,) + tail))
    return sorted(graphs)


def disconnected_k4_pairs() -> list[tuple[int, ...]]:
    graphs: list[tuple[int, ...]] = []
    vertices = set(range(8))
    for first in itertools.combinations(range(1, 8), 3):
        left = {0, *first}
        right = vertices - left
        graphs.append(complete_on([left, right], 8))
    return graphs


def random_graphs(n: int, count: int, seed: int) -> list[tuple[int, ...]]:
    generator = random.Random(seed)
    result: list[tuple[int, ...]] = []
    probabilities = (0.18, 0.25, 0.35, 0.50, 0.72)
    for index in range(count):
        probability = probabilities[index % len(probabilities)]
        graph = empty(n)
        for high in range(1, n):
            for low in range(high):
                if generator.random() < probability:
                    add_edge(graph, low, high)
        result.append(tuple(graph))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=pathlib.Path, required=True)
    parser.add_argument("--quick", action="store_true")
    arguments = parser.parse_args()

    binary = arguments.binary.resolve()
    if not binary.is_file():
        raise SystemExit(f"binary not found: {binary}")

    total = 0
    suites: list[tuple[int, list[tuple[int, ...]], str]] = []
    for order in range(1, 7):
        graphs = [
            from_mask(order, mask)
            for mask in range(1 << (order * (order - 1) // 2))
        ]
        suites.append((order, graphs, f"all-labelled-n{order}"))
    suites.append(
        (8, all_cycle_ladders(), "all-canonical-C8-plus-opposite-matching")
    )
    suites.append((8, disconnected_k4_pairs(), "all-K4-disjoint-K4-partitions"))
    random_count = 80 if arguments.quick else 500
    for order in range(8, 13):
        suites.append(
            (
                order,
                random_graphs(order, random_count, 0x640000 + order),
                f"random-n{order}",
            )
        )

    for order, graphs, label in suites:
        _, summary = run_filter(binary, order, graphs)
        total += len(graphs)
        print(
            json.dumps(
                {
                    "suite": label,
                    "order": order,
                    "graphs": len(graphs),
                    "rooted_admissible": summary["rooted_admissible"],
                    "with_validated_c8_witness": summary[
                        "with_validated_c8_witness"
                    ],
                    "survivors": summary["survivors_without_c8_witness"],
                },
                sort_keys=True,
            )
        )

    print(
        json.dumps(
            {"status": "ok", "binary": str(binary), "graphs_checked": total},
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
