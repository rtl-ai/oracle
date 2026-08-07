import Mathlib.Combinatorics.SimpleGraph.Paths
import Mathlib.Tactic

/-!
# Finite exact-search certificates for Erdős Problem 64

For a fixed finite graph, an exhaustive checker only needs to reject
power-of-two cycle codes whose lengths do not exceed the number of vertices.
This file proves that such bounded rejection rules out the exact
`SimpleGraph.Walk.IsCycle` witness used by the conjecture.

It also proves the hereditary direction used by minimal-counterexample
reductions: a certificate for a supergraph remains valid after deleting edges.
-/

set_option autoImplicit false

namespace Erdos64FiniteCertificate

open SimpleGraph

/-- The cyclic successor on `Fin L`. -/
def cyclicNext {L : ℕ} (i : Fin L) : Fin L :=
  if h : i.val + 1 < L then
    ⟨i.val + 1, h⟩
  else
    ⟨0, by omega⟩

/-- A finite code for a simple, not-necessarily-induced cycle of exact length
`L`: an injective cyclic vertex listing with all consecutive edges present. -/
def HasCycleCode {V : Type*} (G : SimpleGraph V) (L : ℕ) : Prop :=
  3 ≤ L ∧ ∃ f : Fin L → V,
    Function.Injective f ∧
      ∀ i : Fin L, G.Adj (f i) (f (cyclicNext i))

/-- Exact-length cycle codes are decidable on a finite graph with decidable
adjacency. -/
instance instDecidableHasCycleCode
    {V : Type*} [Fintype V] [DecidableEq V]
    (G : SimpleGraph V) [DecidableRel G.Adj] (L : ℕ) :
    Decidable (HasCycleCode G L) := by
  unfold HasCycleCode
  infer_instance

/-- Every mathlib simple cycle of exact length `L` yields a finite cycle code. -/
theorem hasCycleCode_of_isCycle
    {V : Type*} {G : SimpleGraph V} {v : V} {c : G.Walk v v} {L : ℕ}
    (hc : c.IsCycle) (hlen : c.length = L) :
    HasCycleCode G L := by
  have hL : 3 ≤ L := by
    simpa [hlen] using hc.three_le_length
  refine ⟨hL, fun i => c.getVert i.val, ?_, ?_⟩
  · intro i j hij
    apply Fin.ext
    apply hc.getVert_injOn'
    · simp only [Set.mem_setOf_eq]
      omega
    · simp only [Set.mem_setOf_eq]
      omega
    · exact hij
  · intro i
    by_cases hnext : i.val + 1 < L
    · have hi : i.val < c.length := by omega
      simpa [cyclicNext, hnext] using c.adj_getVert_succ hi
    · have hi : i.val < c.length := by omega
      have hilast : i.val + 1 = L := by omega
      simpa [cyclicNext, hnext, hilast, ← hlen] using c.adj_getVert_succ hi

/-- A simple cycle in a finite graph has length at most the graph order. -/
theorem cycle_length_le_card
    {V : Type*} [Fintype V] {G : SimpleGraph V}
    {v : V} {c : G.Walk v v} (hc : c.IsCycle) :
    c.length ≤ Fintype.card V := by
  cases c with
  | nil => simp
  | cons h p =>
      have hp : p.IsPath :=
        ((SimpleGraph.Walk.cons_isCycle_iff p h).mp hc).1
      have hlt : p.length < Fintype.card V := hp.length_lt
      rw [SimpleGraph.Walk.length_cons]
      omega

/-- The witness shape on the right-hand side of Erdős Problem 64. -/
def HasPowerCycleWalk {V : Type*} (G : SimpleGraph V) : Prop :=
  ∃ (k : ℕ) (v : V) (c : G.Walk v v),
    2 ≤ k ∧ c.IsCycle ∧ c.length = 2 ^ k

/-- The finite certificate condition checked by an exhaustive search. -/
def AvoidsPowerCycleCodesUpToCard
    {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  ∀ k : ℕ, 2 ≤ k → 2 ^ k ≤ Fintype.card V →
    ¬ HasCycleCode G (2 ^ k)

/-- Every exact power-cycle walk witness produces a bounded finite code. -/
theorem boundedCycleCode_of_powerCycleWalk
    {V : Type*} [Fintype V] {G : SimpleGraph V}
    (h : HasPowerCycleWalk G) :
    ∃ k : ℕ, 2 ≤ k ∧ 2 ^ k ≤ Fintype.card V ∧
      HasCycleCode G (2 ^ k) := by
  rcases h with ⟨k, v, c, hk, hc, hlen⟩
  refine ⟨k, hk, ?_, ?_⟩
  · rw [← hlen]
    exact cycle_length_le_card hc
  · exact hasCycleCode_of_isCycle hc hlen

/-- Soundness of a bounded finite exact-search certificate. -/
theorem noPowerCycleWalk_of_avoidsPowerCycleCodesUpToCard
    {V : Type*} [Fintype V] {G : SimpleGraph V}
    (hcert : AvoidsPowerCycleCodesUpToCard G) :
    ¬ HasPowerCycleWalk G := by
  intro hwalk
  rcases boundedCycleCode_of_powerCycleWalk hwalk with
    ⟨k, hk, hbound, hcode⟩
  exact hcert k hk hbound hcode

/-- Enlarging the adjacency relation preserves every exact cycle code. -/
theorem hasCycleCode_of_adj_mono
    {V : Type*} {G H : SimpleGraph V} {L : ℕ}
    (hcode : HasCycleCode G L)
    (hAdj : ∀ u v : V, G.Adj u v → H.Adj u v) :
    HasCycleCode H L := by
  rcases hcode with ⟨hL, f, hf, hedges⟩
  refine ⟨hL, f, hf, ?_⟩
  intro i
  exact hAdj (f i) (f (cyclicNext i)) (hedges i)

/-- Bounded power-cycle-code avoidance is preserved by deleting edges. -/
theorem avoidsPowerCycleCodesUpToCard_antiAdj
    {V : Type*} [Fintype V] {G H : SimpleGraph V}
    (hAdj : ∀ u v : V, G.Adj u v → H.Adj u v)
    (hH : AvoidsPowerCycleCodesUpToCard H) :
    AvoidsPowerCycleCodesUpToCard G := by
  intro k hk hbound hG
  exact hH k hk hbound (hasCycleCode_of_adj_mono hG hAdj)

/-- A bounded certificate for a supergraph rules out exact power-cycle walks in
any edge-subgraph on the same finite vertex type. -/
theorem noPowerCycleWalk_of_subgraph_certificate
    {V : Type*} [Fintype V] {G H : SimpleGraph V}
    (hAdj : ∀ u v : V, G.Adj u v → H.Adj u v)
    (hH : AvoidsPowerCycleCodesUpToCard H) :
    ¬ HasPowerCycleWalk G := by
  apply noPowerCycleWalk_of_avoidsPowerCycleCodesUpToCard
  exact avoidsPowerCycleCodesUpToCard_antiAdj hAdj hH

#print axioms Erdos64FiniteCertificate.hasCycleCode_of_isCycle
#print axioms Erdos64FiniteCertificate.cycle_length_le_card
#print axioms Erdos64FiniteCertificate.boundedCycleCode_of_powerCycleWalk
#print axioms Erdos64FiniteCertificate.noPowerCycleWalk_of_avoidsPowerCycleCodesUpToCard
#print axioms Erdos64FiniteCertificate.hasCycleCode_of_adj_mono
#print axioms Erdos64FiniteCertificate.avoidsPowerCycleCodesUpToCard_antiAdj
#print axioms Erdos64FiniteCertificate.noPowerCycleWalk_of_subgraph_certificate

end Erdos64FiniteCertificate
