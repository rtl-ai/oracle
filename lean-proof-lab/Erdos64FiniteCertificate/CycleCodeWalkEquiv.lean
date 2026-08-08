import Erdos64FiniteCertificate.CycleCodeBounds
import Mathlib.Data.List.OfFn

/-!
# Constructing exact walks from finite cycle codes

This module begins the reverse bridge from executable finite cycle codes to
Mathlib's dependent `SimpleGraph.Walk` representation.  The central constructor
turns an explicitly edge-linked tuple into the corresponding walk, while
retaining exact length and support information.
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
      let f' : Fin (n + 1) → V := fun i => f i.castSucc
      have h' : ∀ i : Fin n, G.Adj (f' i.castSucc) (f' i.succ) := by
        intro i
        simpa [f'] using h i.castSucc
      have hlast : G.Adj (f' (Fin.last n)) (f (Fin.last (n + 1))) := by
        simpa [f'] using h (Fin.last n)
      simpa [f'] using (linearWalk G n f' h').concat hlast

@[simp]
theorem linearWalk_length
    {V : Type*} (G : SimpleGraph V) (n : ℕ)
    (f : Fin (n + 1) → V)
    (h : ∀ i : Fin n, G.Adj (f i.castSucc) (f i.succ)) :
    (linearWalk G n f h).length = n := by
  induction n generalizing f with
  | zero => simp [linearWalk]
  | succ n ih =>
      simp [linearWalk, ih]

@[simp]
theorem linearWalk_support
    {V : Type*} (G : SimpleGraph V) (n : ℕ)
    (f : Fin (n + 1) → V)
    (h : ∀ i : Fin n, G.Adj (f i.castSucc) (f i.succ)) :
    (linearWalk G n f h).support = List.ofFn f := by
  induction n generalizing f with
  | zero => simp [linearWalk, List.ofFn_succ']
  | succ n ih =>
      simp [linearWalk, ih, List.ofFn_succ']

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

#print axioms Erdos64FiniteCertificate.linearWalk_length
#print axioms Erdos64FiniteCertificate.linearWalk_support
#print axioms Erdos64FiniteCertificate.linearWalk_isPath

end Erdos64FiniteCertificate
