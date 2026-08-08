import Erdos64FiniteCertificate.FiniteCertificateBridge

/-!
# Cardinal bounds and relabeling for Erdős 64 cycle certificates

This file closes a finite-search bookkeeping gap left by the original
certificate bridge. An injective cycle code of length `L` itself proves
`L ≤ Fintype.card V`; consequently the checker condition restricted to lengths
that fit in the vertex set is equivalent to rejecting all power-of-two cycle
codes.

It also proves that exact cycle codes are preserved by injective
adjacency-preserving relabelings and hence are invariant under graph
isomorphism data presented as an equivalence with adjacency reflection.
-/

set_option autoImplicit false

namespace Erdos64FiniteCertificate

open SimpleGraph

/-- Every injectively encoded cycle fits in its finite vertex type. -/
theorem cycleCode_length_le_card
    {V : Type*} [Fintype V] {G : SimpleGraph V} {L : ℕ}
    (hcode : HasCycleCode G L) :
    L ≤ Fintype.card V := by
  rcases hcode with ⟨_, f, hf, _⟩
  simpa using Fintype.card_le_of_injective f hf

/-- A requested length larger than the graph order cannot have an injective
cycle code. -/
theorem no_hasCycleCode_of_card_lt
    {V : Type*} [Fintype V] {G : SimpleGraph V} {L : ℕ}
    (hlarge : Fintype.card V < L) :
    ¬ HasCycleCode G L := by
  intro hcode
  exact (not_le_of_gt hlarge) (cycleCode_length_le_card hcode)

/-- The unbounded mathematical statement that every admissible power-of-two
cycle code is absent. -/
def AvoidsAllPowerCycleCodes {V : Type*} (G : SimpleGraph V) : Prop :=
  ∀ k : ℕ, 2 ≤ k → ¬ HasCycleCode G (2 ^ k)

/-- The order bound used by a finite checker loses no information: every cycle
code automatically satisfies that bound. -/
theorem avoidsPowerCycleCodesUpToCard_iff_avoidsAllPowerCycleCodes
    {V : Type*} [Fintype V] (G : SimpleGraph V) :
    AvoidsPowerCycleCodesUpToCard G ↔ AvoidsAllPowerCycleCodes G := by
  constructor
  · intro hbounded k hk hcode
    exact hbounded k hk (cycleCode_length_le_card hcode) hcode
  · intro hall k hk _ hcode
    exact hall k hk hcode

/-- Rejecting all power-of-two cycle codes rules out the exact walk witness in
the formal-conjectures formulation. -/
theorem noPowerCycleWalk_of_avoidsAllPowerCycleCodes
    {V : Type*} [Fintype V] {G : SimpleGraph V}
    (hall : AvoidsAllPowerCycleCodes G) :
    ¬ HasPowerCycleWalk G := by
  apply noPowerCycleWalk_of_avoidsPowerCycleCodesUpToCard
  exact
    (avoidsPowerCycleCodesUpToCard_iff_avoidsAllPowerCycleCodes G).2 hall

/-- An injective vertex relabeling that sends edges to edges sends every exact
cycle code to an exact cycle code. -/
theorem hasCycleCode_of_injective_relabel
    {V W : Type*} {G : SimpleGraph V} {H : SimpleGraph W} {L : ℕ}
    (φ : V → W) (hφ : Function.Injective φ)
    (hAdj : ∀ ⦃u v : V⦄, G.Adj u v → H.Adj (φ u) (φ v))
    (hcode : HasCycleCode G L) :
    HasCycleCode H L := by
  rcases hcode with ⟨hL, f, hf, hedges⟩
  refine ⟨hL, φ ∘ f, hφ.comp hf, ?_⟩
  intro i
  exact hAdj (hedges i)

/-- Exact cycle-code existence is invariant under a bijective relabeling that
preserves and reflects adjacency. -/
theorem hasCycleCode_iff_of_equiv
    {V W : Type*} {G : SimpleGraph V} {H : SimpleGraph W} {L : ℕ}
    (e : V ≃ W)
    (hAdj : ∀ u v : V, G.Adj u v ↔ H.Adj (e u) (e v)) :
    HasCycleCode G L ↔ HasCycleCode H L := by
  constructor
  · intro hcode
    refine hasCycleCode_of_injective_relabel
      (V := V) (W := W) (G := G) (H := H) (L := L)
      e e.injective ?_ hcode
    intro u v huv
    exact (hAdj u v).1 huv
  · intro hcode
    refine hasCycleCode_of_injective_relabel
      (V := W) (W := V) (G := H) (H := G) (L := L)
      e.symm e.symm.injective ?_ hcode
    intro x y hxy
    apply (hAdj (e.symm x) (e.symm y)).2
    simpa using hxy

/-- Power-of-two-code avoidance is likewise invariant under graph-isomorphism
data. -/
theorem avoidsAllPowerCycleCodes_iff_of_equiv
    {V W : Type*} {G : SimpleGraph V} {H : SimpleGraph W}
    (e : V ≃ W)
    (hAdj : ∀ u v : V, G.Adj u v ↔ H.Adj (e u) (e v)) :
    AvoidsAllPowerCycleCodes G ↔ AvoidsAllPowerCycleCodes H := by
  constructor
  · intro hG k hk hH
    exact hG k hk ((hasCycleCode_iff_of_equiv e hAdj).2 hH)
  · intro hH k hk hG
    exact hH k hk ((hasCycleCode_iff_of_equiv e hAdj).1 hG)

#print axioms Erdos64FiniteCertificate.cycleCode_length_le_card
#print axioms Erdos64FiniteCertificate.no_hasCycleCode_of_card_lt
#print axioms Erdos64FiniteCertificate.avoidsPowerCycleCodesUpToCard_iff_avoidsAllPowerCycleCodes
#print axioms Erdos64FiniteCertificate.noPowerCycleWalk_of_avoidsAllPowerCycleCodes
#print axioms Erdos64FiniteCertificate.hasCycleCode_of_injective_relabel
#print axioms Erdos64FiniteCertificate.hasCycleCode_iff_of_equiv
#print axioms Erdos64FiniteCertificate.avoidsAllPowerCycleCodes_iff_of_equiv

end Erdos64FiniteCertificate
