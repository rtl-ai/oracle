import Erdos64FiniteCertificate.CycleCodeWalkEquiv

/-!
# Exact finite-certificate characterization of Erdős Problem 64

This file packages the exact code/walk equivalence into the universal
conjecture statement. A minimum-degree-three finite graph carrying the bounded
avoidance certificate is a formal counterexample, and the conjecture is exactly
equivalent to nonexistence of such certificates.
-/

set_option autoImplicit false

namespace Erdos64FiniteCertificate

open SimpleGraph

universe u

/-- The finite Erdős–Gyárfás power-of-two cycle statement for vertex types in
one fixed universe. -/
def Erdos64Statement.{u} : Prop :=
  ∀ (V : Type u) (G : SimpleGraph V) [Fintype V] [DecidableRel G.Adj],
    G.minDegree ≥ 3 →
      ∃ (k : ℕ) (v : V) (c : G.Walk v v),
        2 ≤ k ∧ c.IsCycle ∧ c.length = 2 ^ k

/-- A finite graph of minimum degree at least three together with an exact
bounded avoidance certificate refutes the universal Erdős 64 statement in the
same universe. -/
theorem not_erdos64Statement_of_finite_certificate
    {V : Type u} [Fintype V] {G : SimpleGraph V} [DecidableRel G.Adj]
    (hδ : G.minDegree ≥ 3)
    (hcert : AvoidsPowerCycleCodesUpToCard G) :
    ¬ Erdos64Statement.{u} := by
  intro hstatement
  have hno : ¬ HasPowerCycleWalk G :=
    (avoidsPowerCycleCodesUpToCard_iff_not_hasPowerCycleWalk G).1 hcert
  exact hno (hstatement V G hδ)

/-- The conjecture at a fixed universe level is exactly equivalent to
nonexistence of a bounded finite avoidance certificate on every finite
minimum-degree-three graph at that level. -/
theorem erdos64Statement_iff_no_finite_certificate_counterexample :
    Erdos64Statement.{u} ↔
      ∀ (V : Type u) (G : SimpleGraph V) [Fintype V] [DecidableRel G.Adj],
        G.minDegree ≥ 3 → ¬ AvoidsPowerCycleCodesUpToCard G := by
  constructor
  · intro hstatement V G _ _ hδ hcert
    exact not_erdos64Statement_of_finite_certificate hδ hcert hstatement
  · intro hcertless V G _ _ hδ
    change HasPowerCycleWalk G
    classical
    by_contra hno
    exact hcertless V G hδ
      ((avoidsPowerCycleCodesUpToCard_iff_not_hasPowerCycleWalk G).2 hno)

#print axioms Erdos64FiniteCertificate.not_erdos64Statement_of_finite_certificate
#print axioms Erdos64FiniteCertificate.erdos64Statement_iff_no_finite_certificate_counterexample

end Erdos64FiniteCertificate
