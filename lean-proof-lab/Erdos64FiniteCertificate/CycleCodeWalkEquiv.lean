import Erdos64FiniteCertificate.CycleCodeBounds
import Mathlib.Data.List.OfFn

/-!
# Exact equivalence between finite cycle codes and walk cycles

This module constructs Mathlib's dependent `SimpleGraph.Walk` objects from
explicit finite vertex tuples.  It proves exact length and support formulas,
shows injective linked tuples form paths, closes such paths into simple cycles,
and establishes the reverse implication missing from the original finite-search
certificate bridge.
-/

set_option autoImplicit false

namespace Erdos64FiniteCertificate

open SimpleGraph

/-- The walk through an explicitly edge-linked tuple of `n + 1` vertices. -/
def linearWalk {V : Type*} (G : SimpleGraph V) :
    (n : ℕ) →
    (f : Fin (n + 1) → V) →
    (∀ i : Fin n, G.Adj (f i.castSucc) (f i.succ)) →
    G.Walk (f 0) (f (Fin.last n))
  | 0, f, _ => by
      simpa using (Walk.nil : G.Walk (f 0) (f 0))
  | n + 1, f, h => by
      let f' : Fin (n + 1) → V := fun i => f i.succ
      have h' : ∀ i : Fin n, G.Adj (f' i.castSucc) (f' i.succ) := by
        intro i
        simpa [f'] using h i.succ
      have hfirst : G.Adj (f 0) (f' 0) := by
        simpa [f'] using h (0 : Fin (n + 1))
      simpa [f'] using Walk.cons hfirst (linearWalk G n f' h')

@[simp]
theorem linearWalk_length
    {V : Type*} (G : SimpleGraph V) (n : ℕ)
    (f : Fin (n + 1) → V)
    (h : ∀ i : Fin n, G.Adj (f i.castSucc) (f i.succ)) :
    (linearWalk G n f h).length = n := by
  induction n with
  | zero => simp [linearWalk]
  | succ n ih =>
      simp [linearWalk, ih]

@[simp]
theorem linearWalk_support
    {V : Type*} (G : SimpleGraph V) (n : ℕ)
    (f : Fin (n + 1) → V)
    (h : ∀ i : Fin n, G.Adj (f i.castSucc) (f i.succ)) :
    (linearWalk G n f h).support = List.ofFn f := by
  induction n with
  | zero => simp [linearWalk]
  | succ n ih =>
      simp [linearWalk, ih]

/-- An injective linked tuple produces a path. -/
theorem linearWalk_isPath
    {V : Type*} {G : SimpleGraph V} {n : ℕ}
    {f : Fin (n + 1) → V}
    {h : ∀ i : Fin n, G.Adj (f i.castSucc) (f i.succ)}
    (hf : Function.Injective f) :
    (linearWalk G n f h).IsPath := by
  apply Walk.IsPath.mk'
  rw [linearWalk_support]
  exact List.nodup_ofFn.mpr hf

@[simp]
theorem cyclicNext_castSucc {n : ℕ} (i : Fin n) :
    cyclicNext i.castSucc = i.succ := by
  apply Fin.ext
  simp [cyclicNext, i.isLt]

@[simp]
theorem cyclicNext_last {n : ℕ} :
    cyclicNext (Fin.last n) = 0 := by
  apply Fin.ext
  simp [cyclicNext]

/-- In a path of length at least two, the unordered endpoint edge cannot already
occur in the path. -/
theorem endpointEdge_not_mem_edges
    {V : Type*} {G : SimpleGraph V} {u v : V} {p : G.Walk u v}
    (hp : p.IsPath) (hlen : 2 ≤ p.length) :
    s(u, v) ∉ p.edges := by
  intro hmem
  have hmem' : s(v, u) ∈ p.edges := by
    simpa only [Sym2.eq_swap] using hmem
  have hu : u = p.penultimate :=
    hp.eq_penultimate_of_mem_edges hmem'
  have hindex : p.length - 1 = 0 := by
    apply (hp.getVert_eq_start_iff (i := p.length - 1) (Nat.sub_le _ _)).1
    exact hu.symm
  omega

/-- Closing a path of length at least two with its endpoint edge gives a simple
cycle. -/
theorem concat_isCycle_of_isPath
    {V : Type*} {G : SimpleGraph V} {u v : V} {p : G.Walk u v}
    (hp : p.IsPath) (hlen : 2 ≤ p.length) (hclose : G.Adj v u) :
    (p.concat hclose).IsCycle := by
  rw [← Walk.isCycle_reverse, Walk.reverse_concat, Walk.cons_isCycle_iff]
  refine ⟨hp.reverse, ?_⟩
  simpa using endpointEdge_not_mem_edges hp hlen

/-- Every executable finite cycle code yields a Mathlib simple cycle of the
same exact length. -/
theorem exists_isCycle_of_hasCycleCode
    {V : Type*} {G : SimpleGraph V} {L : ℕ}
    (hcode : HasCycleCode G L) :
    ∃ (v : V) (c : G.Walk v v), c.IsCycle ∧ c.length = L := by
  rcases hcode with ⟨hL, f, hf, hedges⟩
  cases L with
  | zero => omega
  | succ n =>
      have hn : 2 ≤ n := by omega
      have hlinear : ∀ i : Fin n, G.Adj (f i.castSucc) (f i.succ) := by
        intro i
        simpa using hedges i.castSucc
      let p : G.Walk (f 0) (f (Fin.last n)) := linearWalk G n f hlinear
      have hp : p.IsPath := by
        exact linearWalk_isPath hf
      have hplen : p.length = n := by
        simp [p]
      have hclose : G.Adj (f (Fin.last n)) (f 0) := by
        simpa using hedges (Fin.last n)
      refine ⟨f 0, p.concat hclose, ?_, ?_⟩
      · exact concat_isCycle_of_isPath hp (hplen.symm ▸ hn) hclose
      · simp [p]

/-- Finite cycle codes and Mathlib simple-cycle walks are exactly equivalent at
each requested length. -/
theorem hasCycleCode_iff_exists_isCycle
    {V : Type*} {G : SimpleGraph V} {L : ℕ} :
    HasCycleCode G L ↔
      ∃ (v : V) (c : G.Walk v v), c.IsCycle ∧ c.length = L := by
  constructor
  · exact exists_isCycle_of_hasCycleCode
  · rintro ⟨v, c, hc, hlen⟩
    exact hasCycleCode_of_isCycle hc hlen

/-- Consequently, avoidance of all admissible power-of-two finite codes is
exactly the negation of the walk-cycle witness used in Erdős Problem 64. -/
theorem avoidsAllPowerCycleCodes_iff_not_hasPowerCycleWalk
    {V : Type*} (G : SimpleGraph V) :
    AvoidsAllPowerCycleCodes G ↔ ¬ HasPowerCycleWalk G := by
  constructor
  · intro hall hwalk
    rcases hwalk with ⟨k, v, c, hk, hc, hlen⟩
    exact hall k hk (hasCycleCode_of_isCycle hc hlen)
  · intro hno k hk hcode
    rcases exists_isCycle_of_hasCycleCode hcode with ⟨v, c, hc, hlen⟩
    exact hno ⟨k, v, c, hk, hc, hlen⟩

#print axioms Erdos64FiniteCertificate.linearWalk_length
#print axioms Erdos64FiniteCertificate.linearWalk_support
#print axioms Erdos64FiniteCertificate.linearWalk_isPath
#print axioms Erdos64FiniteCertificate.cyclicNext_castSucc
#print axioms Erdos64FiniteCertificate.cyclicNext_last
#print axioms Erdos64FiniteCertificate.endpointEdge_not_mem_edges
#print axioms Erdos64FiniteCertificate.concat_isCycle_of_isPath
#print axioms Erdos64FiniteCertificate.exists_isCycle_of_hasCycleCode
#print axioms Erdos64FiniteCertificate.hasCycleCode_iff_exists_isCycle
#print axioms Erdos64FiniteCertificate.avoidsAllPowerCycleCodes_iff_not_hasPowerCycleWalk

end Erdos64FiniteCertificate
