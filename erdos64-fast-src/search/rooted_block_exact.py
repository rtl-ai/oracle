#!/usr/bin/env python3
"""Exact rooted-block search filter for Erdős Problem 64.

Reads graph6 records from stdin.  Every record is independently decoded twice,
checked to be a 2-connected graph with minimum degree at least two and at most
one degree-two vertex, and then tested for every power-of-two cycle length by
two independent exact algorithms.  Any disagreement is fatal.

The first cycle algorithm is Held--Karp subset dynamic programming.  The second
fixes the least cycle vertex and its two cycle neighbours, then searches the
remaining simple path by branch-and-bound.  Neither algorithm has a timeout,
depth cutoff, or probabilistic acceptance path.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
from dataclasses import dataclass
from typing import Iterator, Sequence

HEADER = ">>graph6<<"


class InputError(ValueError):
    pass


class Disagreement(RuntimeError):
    pass


def decode_graph6_a(record: str) -> tuple[int, ...]:
    text = record.strip()
    if text.startswith(HEADER):
        text = text[len(HEADER):]
    if not text or text[0] in ":&":
        raise InputError("expected a nonempty graph6 record")
    values = [ord(ch) - 63 for ch in text]
    if any(value < 0 or value > 63 for value in values):
        raise InputError("graph6 character outside 63..126")
    pos = 1
    if values[0] < 63:
        n = values[0]
    elif len(values) >= 4 and values[1] < 63:
        n = (values[1] << 12) | (values[2] << 6) | values[3]
        pos = 4
        if n < 63:
            raise InputError("noncanonical graph6 order prefix")
    elif len(values) >= 8 and values[1] == 63:
        n = 0
        for value in values[2:8]:
            n = (n << 6) | value
        pos = 8
        if n < 258048:
            raise InputError("noncanonical graph6 order prefix")
    else:
        raise InputError("truncated graph6 order prefix")
    edge_bits = n * (n - 1) // 2
    needed = (edge_bits + 5) // 6
    if len(values) - pos != needed:
        raise InputError(f"wrong graph6 payload length for n={n}")
    graph = [0] * n
    bit_index = 0
    for high in range(1, n):
        for low in range(high):
            value = values[pos + bit_index // 6]
            if value & (1 << (5 - bit_index % 6)):
                graph[low] |= 1 << high
                graph[high] |= 1 << low
            bit_index += 1
    if edge_bits % 6 and values[-1] & ((1 << (6 - edge_bits % 6)) - 1):
        raise InputError("nonzero graph6 padding")
    return tuple(graph)


def decode_graph6_b(record: str) -> tuple[int, ...]:
    data = record.strip()
    if data.startswith(HEADER):
        data = data[len(HEADER):]
    if not data or data.startswith((":", "&")):
        raise InputError("not graph6")
    raw = []
    for char in data:
        digit = ord(char) - 63
        if not 0 <= digit <= 63:
            raise InputError("invalid graph6 byte")
        raw.append(digit)
    cursor = 0
    marker = raw[cursor]
    cursor += 1
    if marker <= 62:
        order = marker
    else:
        if cursor >= len(raw):
            raise InputError("missing order")
        if raw[cursor] != 63:
            if cursor + 3 > len(raw):
                raise InputError("short 18-bit order")
            order = raw[cursor] * 4096 + raw[cursor + 1] * 64 + raw[cursor + 2]
            cursor += 3
            if order < 63:
                raise InputError("nonminimal order")
        else:
            cursor += 1
            if cursor + 6 > len(raw):
                raise InputError("short 36-bit order")
            order = 0
            for digit in raw[cursor:cursor + 6]:
                order = 64 * order + digit
            cursor += 6
            if order < 258048:
                raise InputError("nonminimal order")
    bits_needed = order * (order - 1) // 2
    chars_needed = (bits_needed + 5) // 6
    if len(raw) - cursor != chars_needed:
        raise InputError("wrong payload size")
    graph = [0] * order
    position = 0
    for high in range(1, order):
        for low in range(high):
            if raw[cursor + position // 6] & (32 >> (position % 6)):
                graph[low] |= 1 << high
                graph[high] |= 1 << low
            position += 1
    if bits_needed % 6:
        unused = 6 - bits_needed % 6
        if raw[-1] & ((1 << unused) - 1):
            raise InputError("nonzero padding")
    return tuple(graph)


def encode_graph6(graph: Sequence[int]) -> str:
    n = len(graph)
    for u, row in enumerate(graph):
        if row < 0 or row >> n or row & (1 << u):
            raise InputError("invalid adjacency row")
        for v in range(u + 1, n):
            if bool(row & (1 << v)) != bool(graph[v] & (1 << u)):
                raise InputError("asymmetric adjacency")
    if n <= 62:
        values = [n]
    elif n <= 258047:
        values = [63, (n >> 12) & 63, (n >> 6) & 63, n & 63]
    elif n < 1 << 36:
        values = [63, 63] + [(n >> shift) & 63 for shift in (30, 24, 18, 12, 6, 0)]
    else:
        raise InputError("order too large")
    value = width = 0
    for high in range(1, n):
        for low in range(high):
            value = 2 * value + int(bool(graph[low] & (1 << high)))
            width += 1
            if width == 6:
                values.append(value)
                value = width = 0
    if width:
        values.append(value << (6 - width))
    return "".join(chr(value + 63) for value in values)


def is_biconnected(graph: Sequence[int]) -> bool:
    n = len(graph)
    if n < 3:
        return False
    sys.setrecursionlimit(max(1000, 4 * n + 100))
    discovery = [-1] * n
    low = [0] * n
    parent = [-1] * n
    clock = 0
    articulation = False

    def visit(u: int) -> None:
        nonlocal clock, articulation
        discovery[u] = low[u] = clock
        clock += 1
        children = 0
        bits = graph[u]
        while bits:
            bit = bits & -bits
            bits ^= bit
            v = bit.bit_length() - 1
            if discovery[v] == -1:
                parent[v] = u
                children += 1
                visit(v)
                low[u] = min(low[u], low[v])
                if parent[u] == -1 and children > 1:
                    articulation = True
                if parent[u] != -1 and low[v] >= discovery[u]:
                    articulation = True
            elif v != parent[u]:
                low[u] = min(low[u], discovery[v])

    visit(0)
    return not articulation and all(value >= 0 for value in discovery)


@dataclass(frozen=True)
class RootedClass:
    admissible: bool
    root: int | None
    degrees: tuple[int, ...]
    reason: str


def classify(graph: Sequence[int]) -> RootedClass:
    degrees = tuple(row.bit_count() for row in graph)
    if not is_biconnected(graph):
        return RootedClass(False, None, degrees, "not_biconnected")
    if not degrees or min(degrees) < 2:
        return RootedClass(False, None, degrees, "degree_below_2")
    roots = [u for u, degree in enumerate(degrees) if degree == 2]
    if len(roots) > 1:
        return RootedClass(False, None, degrees, "multiple_degree_2_vertices")
    root = roots[0] if roots else None
    if any(degree < 3 for u, degree in enumerate(degrees) if u != root):
        return RootedClass(False, root, degrees, "nonroot_degree_below_3")
    return RootedClass(True, root, degrees, "admissible")


def powers_up_to(n: int) -> tuple[int, ...]:
    result = []
    length = 4
    while length <= n:
        result.append(length)
        length *= 2
    return tuple(result)


def has_cycle_dp(graph: Sequence[int], length: int) -> bool:
    """Held--Karp exact simple-cycle test, rooted at the least cycle vertex."""
    n = len(graph)
    if length < 3 or length > n:
        return False
    full = (1 << n) - 1
    for root in range(n - length + 1):
        root_bit = 1 << root
        greater = full & ~((1 << (root + 1)) - 1)
        firsts = graph[root] & greater
        if firsts.bit_count() < 2:
            continue
        states: dict[int, int] = {}
        bits = firsts
        while bits:
            bit = bits & -bits
            bits ^= bit
            states[root_bit | bit] = bit
        used_count = 2
        while states and used_count < length:
            next_states: dict[int, int] = {}
            final = used_count + 1 == length
            for mask, endpoints in states.items():
                endpoint_bits = endpoints
                while endpoint_bits:
                    last_bit = endpoint_bits & -endpoint_bits
                    endpoint_bits ^= last_bit
                    last = last_bit.bit_length() - 1
                    choices = graph[last] & greater & ~mask
                    if final:
                        choices &= graph[root]
                    while choices:
                        new_bit = choices & -choices
                        choices ^= new_bit
                        new_mask = mask | new_bit
                        next_states[new_mask] = next_states.get(new_mask, 0) | new_bit
            states = next_states
            used_count += 1
        if used_count == length and any(endpoints & graph[root] for endpoints in states.values()):
            return True
    return False


def shortest_distance(graph: Sequence[int], source: int, target: int, allowed: int, budget: int) -> int | None:
    if source == target:
        return 0
    seen = 1 << source
    frontier = seen
    target_bit = 1 << target
    for distance in range(1, budget + 1):
        following = 0
        bits = frontier
        while bits:
            bit = bits & -bits
            bits ^= bit
            following |= graph[bit.bit_length() - 1]
        following &= allowed & ~seen
        if following & target_bit:
            return distance
        if not following:
            return None
        seen |= following
        frontier = following
    return None


def reachable_capacity(graph: Sequence[int], source: int, allowed: int, cap: int) -> int:
    reached = 1 << source
    frontier = reached
    while frontier and reached.bit_count() < cap:
        following = 0
        bits = frontier
        while bits:
            bit = bits & -bits
            bits ^= bit
            following |= graph[bit.bit_length() - 1]
        following &= allowed & ~reached
        reached |= following
        frontier = following
    return min(reached.bit_count(), cap)


def has_cycle_path(graph: Sequence[int], length: int) -> bool:
    """Independent exact cycle test via a path between two root neighbours."""
    n = len(graph)
    if length < 3 or length > n:
        return False
    all_vertices = (1 << n) - 1
    for root in range(n - length + 1):
        greater = all_vertices & ~((1 << (root + 1)) - 1)
        neighbour_bits = graph[root] & greater
        neighbours = []
        bits = neighbour_bits
        while bits:
            bit = bits & -bits
            bits ^= bit
            neighbours.append(bit.bit_length() - 1)
        for left_index, left in enumerate(neighbours):
            for right in neighbours[left_index + 1:]:
                right_bit = 1 << right

                def search(current: int, used: int, remaining_edges: int) -> bool:
                    if remaining_edges == 0:
                        return current == right
                    if current == right:
                        return False
                    residual = (greater & ~used) | (1 << current) | right_bit
                    distance = shortest_distance(graph, current, right, residual, remaining_edges)
                    if distance is None or distance > remaining_edges:
                        return False
                    if reachable_capacity(graph, current, residual, remaining_edges + 1) < remaining_edges + 1:
                        return False
                    choices = graph[current] & greater & ~used
                    choices &= right_bit if remaining_edges == 1 else ~right_bit
                    ordered = []
                    while choices:
                        bit = choices & -choices
                        choices ^= bit
                        ordered.append(bit.bit_length() - 1)
                    ordered.sort(key=lambda v: (graph[v] & residual).bit_count())
                    return any(search(v, used | (1 << v), remaining_edges - 1) for v in ordered)

                if search(left, 1 << left, length - 2):
                    return True
    return False


def records() -> Iterator[tuple[int, str]]:
    for line_number, line in enumerate(sys.stdin, 1):
        text = line.strip()
        if text and not text.startswith("#"):
            yield line_number, text


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--order", type=int, required=True)
    parser.add_argument("--candidates", type=pathlib.Path, required=True)
    parser.add_argument("--summary", type=pathlib.Path, required=True)
    parser.add_argument("--require-c4-free", action="store_true")
    args = parser.parse_args(argv)
    if args.order < 3:
        raise SystemExit("--order must be at least three")
    args.candidates.parent.mkdir(parents=True, exist_ok=True)
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    candidates_tmp = args.candidates.with_suffix(args.candidates.suffix + ".tmp")
    summary_tmp = args.summary.with_suffix(args.summary.suffix + ".tmp")
    summary: dict[str, object] = {
        "order": args.order,
        "input_graphs": 0,
        "rooted_admissible": 0,
        "rooted_with_degree2_exception": 0,
        "ordinary_min_degree3": 0,
        "with_power_of_two_cycle": 0,
        "power_free_candidates": 0,
        "first_hit_histogram": {},
        "rejection_histogram": {},
        "algorithms": ["held-karp-subset-dp", "root-neighbour-path-bnb"],
        "dual_parser_agreement": True,
        "fail_closed": True,
    }
    first_hits: dict[str, int] = {}
    rejections: dict[str, int] = {}
    input_hash = hashlib.sha256()
    try:
        with candidates_tmp.open("w", encoding="utf-8", newline="\n") as output:
            for line_number, record in records():
                summary["input_graphs"] = int(summary["input_graphs"]) + 1
                input_hash.update(record.encode("ascii") + b"\n")
                graph_a = decode_graph6_a(record)
                graph_b = decode_graph6_b(record)
                if graph_a != graph_b:
                    raise Disagreement(f"line {line_number}: graph6 decoders disagree")
                if encode_graph6(graph_a) != encode_graph6(graph_b):
                    raise Disagreement(f"line {line_number}: graph6 encoders disagree")
                if len(graph_a) != args.order:
                    raise InputError(f"line {line_number}: expected n={args.order}, got {len(graph_a)}")
                rooted = classify(graph_a)
                if not rooted.admissible:
                    rejections[rooted.reason] = rejections.get(rooted.reason, 0) + 1
                    continue
                summary["rooted_admissible"] = int(summary["rooted_admissible"]) + 1
                if rooted.root is None:
                    summary["ordinary_min_degree3"] = int(summary["ordinary_min_degree3"]) + 1
                else:
                    summary["rooted_with_degree2_exception"] = int(summary["rooted_with_degree2_exception"]) + 1
                present = []
                for length in powers_up_to(args.order):
                    answer_a = has_cycle_dp(graph_a, length)
                    answer_b = has_cycle_path(graph_b, length)
                    if answer_a != answer_b:
                        raise Disagreement(
                            f"line {line_number}, L={length}: DP={answer_a}, path={answer_b}, graph6={encode_graph6(graph_a)}"
                        )
                    if args.require_c4_free and length == 4 and answer_a:
                        raise Disagreement(f"line {line_number}: -f stream contains C4")
                    if answer_a:
                        present.append(length)
                if present:
                    summary["with_power_of_two_cycle"] = int(summary["with_power_of_two_cycle"]) + 1
                    key = str(present[0])
                    first_hits[key] = first_hits.get(key, 0) + 1
                else:
                    summary["power_free_candidates"] = int(summary["power_free_candidates"]) + 1
                    output.write(json.dumps({
                        "graph6": encode_graph6(graph_a),
                        "order": args.order,
                        "root": rooted.root,
                        "degrees": list(rooted.degrees),
                        "targets": list(powers_up_to(args.order)),
                        "dual_verifier_agreement": True,
                    }, sort_keys=True, separators=(",", ":")) + "\n")
        candidates_tmp.replace(args.candidates)
        summary["input_graph6_sha256"] = input_hash.hexdigest()
        summary["candidate_file_sha256"] = hashlib.sha256(args.candidates.read_bytes()).hexdigest()
        summary["first_hit_histogram"] = dict(sorted(first_hits.items(), key=lambda item: int(item[0])))
        summary["rejection_histogram"] = dict(sorted(rejections.items()))
        summary_tmp.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        summary_tmp.replace(args.summary)
        print(json.dumps(summary, sort_keys=True, separators=(",", ":")))
        return 0
    except Exception:
        candidates_tmp.unlink(missing_ok=True)
        summary_tmp.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
