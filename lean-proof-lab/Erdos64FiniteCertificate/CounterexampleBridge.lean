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

/-- The finite Erdős–Gyárfás power-of-two cycle statement. -/
def Erdos64Statement : Prop :=
  ∀ (V : Type*) (G : SimpleGraph V) [Fintype V] [DecidableRel G.Adj],
    G.minDegree ≥ 3 →
      ∃ (k : ℕ) (v : V) (c : G.Walk v v),
        2 ≤ k ∧ c.IsCycle ∧ c.length = 2 ^ k

/-- A finite graph of minimum degree at least three together with an exact
bounded avoidance certificate refutes the universal Erdős 64 statement. -/
theorem not_erdos64Statement_of_finite_certificate
    {V : Type*} [Fintype V] {G : SimpleGraph V} [DecidableRel G.Adj]
    (hδ : G.minDegree ≥ 3)
    (hcert : AvoidsPowerCycleCodesUpToCard G) :
    ¬ Erdos64Statement := by
  intro hstatement
  have hno : ¬ HasPowerCycleWalk G :=
    (avoidsPowerCycleCodesUpToCard_iff_not_hasPowerCycleWalk G).1 hcert
  exact hno (hstatement V G hδ)

/-- The conjecture is exactly equivalent to nonexistence of a bounded finite
avoidance certificate on every finite minimum-degree-three graph. -/
theorem erdos64Statement_iff_no_finite_certificate_counterexample :
    Erdos64Statement ↔
      ∀ (V : Type*) (G : SimpleGraph V) [Fintype V] [DecidableRel G.Adj],
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
