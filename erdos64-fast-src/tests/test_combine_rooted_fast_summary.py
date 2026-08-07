from __future__ import annotations

import copy
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "search"))

import combine_rooted_fast_summary as combine


def valid_prefilter() -> dict[str, object]:
    return {
        "schema": "erdos64-rooted-prefilter-v1",
        "order": 17,
        "graph6_roundtrip_verified": 1000,
        "header_lines": 0,
        "input_graphs": 1000,
        "invalid_witnesses": 0,
        "malformed_records": 0,
        "ordinary_min_degree_3": 15,
        "rejected_min_degree_below_2": 0,
        "rejected_multiple_degree_2_vertices": 900,
        "rooted_admissible": 100,
        "rooted_with_degree_2_exception": 85,
        "survivors_without_c8_witness": 4,
        "with_validated_c8_witness": 96,
    }


def valid_exact() -> dict[str, object]:
    return {
        "order": 17,
        "input_graphs": 4,
        "rooted_admissible": 4,
        "rooted_with_degree2_exception": 3,
        "ordinary_min_degree3": 1,
        "with_power_of_two_cycle": 3,
        "power_free_candidates": 1,
        "first_hit_histogram": {"16": 3},
        "rejection_histogram": {},
        "algorithms": ["held-karp-subset-dp", "root-neighbour-path-bnb"],
        "dual_parser_agreement": True,
        "fail_closed": True,
    }


class CombineRootedFastSummaryTests(unittest.TestCase):
    def test_valid_combination(self) -> None:
        result = combine.combine(valid_prefilter(), valid_exact())
        counts = result["counts"]
        self.assertEqual(counts["rooted_admissible"], 100)
        self.assertEqual(counts["with_power_of_two_cycle"], 99)
        self.assertEqual(counts["power_free_candidates"], 1)
        self.assertEqual(result["first_hit_histogram"], {"16": 3, "8": 96})
        self.assertTrue(result["counterexample_found"])
        self.assertTrue(all(result["checks"].values()))

    def test_rejects_missing_fallback_survivor(self) -> None:
        exact = valid_exact()
        exact["input_graphs"] = 3
        exact["rooted_admissible"] = 3
        exact["with_power_of_two_cycle"] = 2
        with self.assertRaisesRegex(ValueError, "fallback_received_all_prefilter_survivors"):
            combine.combine(valid_prefilter(), exact)

    def test_rejects_fallback_rejection(self) -> None:
        exact = valid_exact()
        exact["rejection_histogram"] = {"not_biconnected": 1}
        with self.assertRaisesRegex(ValueError, "fallback_rejected_no_prefilter_survivor"):
            combine.combine(valid_prefilter(), exact)

    def test_rejects_invalid_c8_witness(self) -> None:
        prefilter = valid_prefilter()
        prefilter["invalid_witnesses"] = 1
        with self.assertRaisesRegex(ValueError, "no_invalid_c8_witnesses"):
            combine.combine(prefilter, valid_exact())

    def test_rejects_non_integer_count(self) -> None:
        prefilter = valid_prefilter()
        prefilter["rooted_admissible"] = True
        with self.assertRaisesRegex(ValueError, "rooted_admissible"):
            combine.combine(prefilter, valid_exact())

    def test_does_not_mutate_inputs(self) -> None:
        prefilter = valid_prefilter()
        exact = valid_exact()
        before_prefilter = copy.deepcopy(prefilter)
        before_exact = copy.deepcopy(exact)
        combine.combine(prefilter, exact)
        self.assertEqual(prefilter, before_prefilter)
        self.assertEqual(exact, before_exact)


if __name__ == "__main__":
    unittest.main()
