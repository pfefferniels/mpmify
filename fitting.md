# Tempo Curve Fitting: Mathematical Documentation

This document describes the mathematics behind the piecewise tempo curve
fitting algorithm, based on the explicit power-function model from
Berndt (2011, §3).

Berndt's own scheme is an _alternating_ one — fix the boundary tempos and
choose the shapes, then fix the shapes and solve for the tempos. This
implementation does not alternate, and §4 says why: on an accelerando the
two steps pull against each other and the iteration diverges.

---

## 1. Tempo Model

The score is divided into $M$ segments by user-placed boundaries
$d_0 < d_1 < \cdots < d_M$ (in ticks).
Within segment $m$ (from $d_m$ to $d_{m+1}$), the tempo is modelled as

$$
T_m(d) \;=\; \tau_m\,(1 - \varphi_m(x)) \;+\; \tau_{m+1}\,\varphi_m(x),
$$

where

$$
x \;=\; \frac{d - d_m}{d_{m+1} - d_m} \;\in [0,1],
\qquad
\varphi_m(x) \;=\; x^{\,p_m},
\qquad
p_m \;=\; \frac{\ln 0.5}{\ln i_m}.
$$

**Parameters per segment:**

| Symbol                                                  | Meaning                                                   |
| ------------------------------------------------------- | --------------------------------------------------------- |
| $\tau_m, \tau_{m+1}$                                    | Boundary tempos (BPM) at $d_m$ and $d_{m+1}$              |
| $i_m \in [0.02, 0.98]$                                  | Shape parameter controlling the curve's inflection point  |
| $\hat{s}_m \in \{\text{acc}, \text{rit}, \text{auto}\}$ | Direction inferred automatically from local segment trend |

**Interpretation of $i_m$:**

- $i_m = 0.5 \;\Rightarrow\; p = 1$: linear interpolation.
- $i_m < 0.5 \;\Rightarrow\; 0 < p < 1$: concave ("root") shape — tempo changes early.
- $i_m > 0.5 \;\Rightarrow\; p > 1$: convex ("power") shape — tempo changes late.

The name $i_m$ comes from Berndt's observation that the mean tempo
$\bar{T} = \tfrac{1}{2}(\tau_m + \tau_{m+1})$ is reached at
$x = i_m$, i.e. $\varphi_m(i_m) = i_m^{p_m} = 0.5$.

Boundary tempos are held to $[5, 600]$ BPM and shapes to $[0.02, 0.98]$,
which is the range `meanTempoAt` is written out over — so the value fitted
is the value the document gets, rather than one clamped afterwards.

### 1.1 The forward map is the renderer's

The quantity the fit is built on is not $T$ but the elapsed time under it:

$$
E_m(x) \;=\; L_m \int_0^{x} \frac{60000}{T_m(u)}\,\mathrm{d}u,
\qquad
L_m = \frac{d_{m+1} - d_m}{B} \quad\text{(in beats)}.
$$

There is no closed form, and **this module does not evaluate it itself**.
$E_m$ is `millisecondsAt` — espressivo's Simpson rule, one sub-interval per
sixteenth note over $[d_m, d]$ — because the renderer is what decides whether
a fit is right. The distinction is not pedantic. Against an exact evaluation
of the integral (substitute $u = x^{p}$ to remove the singular derivative at
$x = 0$, then Gauss–Legendre), the renderer is within 0.5 ms for
$i_m \ge 0.3$ but drifts to about 8 ms on strongly concave shapes. A fitter
chasing single-digit milliseconds cannot afford to be exactly right about a
curve nobody will play.

The power function therefore appears nowhere in
`ApproximateLogarithmicTempo.ts`. See the header of `tempoCalculations.ts`
for the same argument made about the inverse direction.

---

## 2. Data

### 2.1 Onset Pairs

The input data consists of onset pairs $(d_j, t_j)$ — score position
in ticks and physical time in milliseconds. These are collected from
two sources:

- **MSM notes** — the notes at a score position contribute that position and
  the **median** of their `midi.onset` values. A chord is one onset, and when
  it happened is a question about the chord rather than about whichever of its
  notes the MSM lists first; spread and asynchrony are the point of a
  performance model, so the first note is an arbitrary member of a spread that
  can be tens of milliseconds wide.
- **Silent onsets** — user-supplied timing anchors at score positions
  where no sounding note exists (e.g. rests).

A silent onset wins over any note at the same date: it is an explicit anchor
the caller placed. All physical times are made relative to the first onset in
the range.

### 2.2 Tempo Points (initialisation only)

From consecutive onset pairs we compute inter-onset interval (IOI)
tempo points. Let $B = \texttt{beatLength} \times 4 \times 720$ be
the beat length in ticks (e.g. 720 for a quarter note when
$\texttt{beatLength} = 0.25$). Then

$$
\text{BPM}_j \;=\; \frac{60000 \cdot \Delta d_j}{\Delta t_j \cdot B},
\qquad
\text{position}_j = \tfrac{1}{2}(d_j + d_{j+1}),
$$

assigned to the interval **midpoint**, because an IOI BPM is the harmonic
mean of $T$ over the interval and that approximates the instantaneous tempo
at the midpoint rather than at either end.

Points with $\Delta d \le 0$, $\Delta t \le 0$, or
$\text{BPM} \notin [5, 600]$ are discarded.

**These points do not enter the fit.** They seed the boundary tempos (§3.1)
and decide each segment's direction (§5), and nothing else. That is what the
silent 5–600 band is for: keeping a grace note or a mis-aligned onset out of
the _initial estimate_, which is the one place a single wild interval could
still send the search into the wrong basin.

### 2.3 Onset weighting

Each onset carries its Voronoi share of score time, capped at one beat:

$$
w_j \;=\; \min\!\left(1,\; \frac{\tfrac{1}{2}(d_{j+1} - d_{j-1})}{B}\right),
$$

one-sided at the ends of the span. A quarter-note spacing gets full weight
$w = 1$; four sixteenths get $0.25$ each and count as one beat between them.
This carries over what the old per-IOI weighting did — a dense passage does
not outvote a sparse one merely by having more notes in it, and the
subdivision level, where expressive displacement lives, does not outweigh the
beat. Under this weighting the objective of §3 is a Riemann sum of squared
timing error against score time.

### 2.4 Segment anchors

Each onset is assigned to the segment containing it and carries its elapsed
time from **that segment's own** observed boundary,

$$
\Delta t_j \;=\; t_j - t(d_m), \qquad j \in S_m,
$$

where $t(d_m)$ is the observed physical time at $d_m$, linearly interpolated
if no onset falls exactly there.

Anchoring per segment rather than at the head of the chain is what makes the
whole scheme affordable — it is the reason the Jacobian is banded (§4.1) —
and it stops timing error accumulating along a chain: each segment is asked
to take the time it took, not to make up for its predecessors.

A segment whose end falls between two onsets gets one synthetic anchor there
holding the interpolated boundary time. This is the old _timing constraint_,
now expressed as one more row of the same least-squares problem rather than
as a penalty with a weight of its own. It is added only where the boundary
lies inside the observed range: past the last onset the interpolation is a
clamp, and an anchor built on it would assert that the rest of the segment
takes no time at all.

---

## 3. The objective

$$
\mathcal{F}(\boldsymbol{\tau}, \mathbf{i}) \;=\;
\sum_{m=0}^{M-1} \sum_{j \in S_m}
  w_j\,\bigl(E_m(x_j;\, \tau_m, \tau_{m+1}, i_m) - \Delta t_j\bigr)^2 .
$$

That is the whole of it. There is no separate timing penalty and no weight
balancing one term against another.

**Why milliseconds and not BPM.** The old objective was a weighted
least-squares fit of $T_m(d_j)$ to $\text{BPM}_j$, with the elapsed-time
requirement added as a linearised penalty of fixed weight $w_t = 5$. Two
things are wrong with that, and they compound:

1. _The unit._ $\text{BPM} \propto 1/\Delta t$, so a fixed timing jitter
   $\sigma$ becomes a BPM error scaling as $\text{BPM}^2\sigma$, i.e. a
   variance scaling as $\text{BPM}^4$. Least squares over BPM therefore
   assumes a noise model the data does not have, and assumes it in the
   direction that matters — under-weighting exactly the slow passages that
   dominate elapsed time, since elapsed time is the integral of $1/T$.

2. _The balance._ The IOI term's total weight grows with the number of
   intervals in the segment; the timing term's did not. On a 16-IOI segment
   the constraint that actually encodes "reproduce the performance" was
   outweighed three to one, and on a long segment it disappeared.

Both dissolve here rather than being retuned. The requirement that a segment
take as long as it took is the residual at $x = 1$ — one row among the
others, weighted like its neighbours, its influence scaling with the
segment's data by construction. A robustness property comes with it: a
displaced onset spoils its own row and no other, where an IOI would have
spoiled two.

### 3.1 Initialisation

Per-segment weighted linear regression of $\text{BPM}_j$ on $x_j$ gives
$\tau_m = a$ and $\tau_{m+1} = a + b$; shared boundaries average the estimates
from the two segments that meet there. Each shape is then seeded by the 1-D
search of §4.3 at those tempos.

---

## 4. Optimisation

### 4.0 Why not alternate

Berndt's alternating scheme, and the shape this code had before, is:

> repeat: (A) fix $\boldsymbol\tau$, choose each $i_m$; (B) fix $\mathbf{i}$,
> solve for $\boldsymbol\tau$.

Alternating minimisation converges only if both steps descend the _same_
function. The two steps here descended different ones — (A) squared elapsed
milliseconds, (B) squared BPM plus the timing penalty — and the composed map
is then not a descent method on anything. On an accelerando it diverged.
Traced over the 30 iterations of a 60 → 120 fit, every figure got
monotonically worse: BPM SSE $3.1{\times}10^{2} \to 7.9{\times}10^{2}$,
elapsed SSE $3.4{\times}10^{5} \to 7.5{\times}10^{5}$, segment duration error
30 ms → 45 ms. The loop stopped because it ran out of iterations, and what it
returned was worse than what it started from.

The divergence is directional, which is why ritardandi looked fine. Elapsed
time is $\int 1/T$, so it is dominated by the segment's _slow_ end. On a
ritardando the slow end is $\tau_{m+1}$, whose coefficient is $\varphi$ —
and $\varphi$ grows as $i_m$ shrinks, so the parameter the timing depends on
gains leverage as the shape moves, and the loop self-corrects. On an
accelerando the slow end is $\tau_m$, whose coefficient is $1 - \varphi$,
which _loses_ leverage as $i_m$ shrinks. A shape error drags $\tau_m$ down, a
low $\tau_m$ makes the model start too slow, and step (A) answers by
shrinking $i_m$ further. The feedback is positive and it runs away. That, and
not the weight of the timing term, is the 27-fold acc/rit asymmetry the issue
reported.

Unifying the objective is necessary but not sufficient: with one objective
and both steps descending it, the iteration converges — but along a curved
valley, at a rate that can be arbitrarily slow. At the initial estimate
$\boldsymbol\tau = (50.3, 110.5)$ for a true 60 → 120, choosing the shape
alone drops $\mathcal{F}$ from $1.5{\times}10^{7}$ to $3.4{\times}10^{5}$:
the shape absorbs almost everything a wrong $\boldsymbol\tau$ costs, leaving
the $\boldsymbol\tau$ step no gradient to work with. The pair creeps 0.13 BPM
per iteration along the floor of the valley.

The valley is an artefact of splitting the variables. So the variables are
not split.

### 4.1 The joint system is banded

Order the unknowns as

$$
v \;=\; (\tau_0,\; i_0,\; \tau_1,\; i_1,\; \ldots,\; i_{M-1},\; \tau_M),
\qquad
\dim v = 2M + 1,
$$

so that $\tau_m, i_m, \tau_{m+1}$ occupy indices $2m, 2m{+}1, 2m{+}2$.

By §2.4 a residual in segment $m$ depends on $\tau_m$, $i_m$ and
$\tau_{m+1}$ and on nothing upstream — so every row of the Jacobian $J$ has
**three adjacent non-zeros**, $J^{\mathsf T}J$ has half-bandwidth two, and a
banded Cholesky solves the normal equations in $O(M)$.

The Jacobian is taken by central differences on the renderer
($\varepsilon = 0.5$ BPM, $10^{-3}$ in shape) rather than in closed form,
because the renderer _is_ the model: its Simpson rule picks its own
sub-interval count from the span, and differentiating a hand copy of it would
reintroduce exactly the drift `tempoCalculations` was rewritten to remove.
Seven evaluations of $E_m$ per segment covers it.

### 4.2 The step

One iteration is a projected, damped Gauss–Newton step:

$$
\bigl(\tilde J^{\mathsf T} W \tilde J + (\rho + \mu) I\bigr)\,\tilde\delta
\;=\; -\tilde J^{\mathsf T} W r - \rho\,(\tilde v - \tilde v_0),
$$

written in the **column-scaled** variables
$\tilde v_i = v_i \, n_i$, $n_i = \sqrt{\max(\left[J^{\mathsf T}WJ\right]_{ii},\; 10^{-12}\lVert\cdot\rVert_\infty)}$.

The scaling is not cosmetic. BPM and a shape parameter in $[0,1]$ are not
commensurable, and the columns of $J$ say so: on a sixteen-beat accelerando
the shape's curvature is $4.1{\times}10^{8}$ and the arrival tempo's is
$9.0{\times}10^{3}$, a ratio of 46 000. Any floor or damping expressed as a
fraction of the _largest_ curvature is several per cent of the smallest —
enough to cancel most of the data's own gradient there and leave the fit
stationary five BPM and 0.15 of a shape short of a curve it can represent
exactly. In the scaled space every constrained unknown has unit curvature and
$\rho = 10^{-8}$ means $10^{-8}$ to all of them alike.

- $\rho$ is a **rank floor**, pulling to the regression estimate for a tempo
  and to a linear ramp for a shape. It answers a boundary or a shape no data
  speaks for, and does nothing whatsoever to one the data constrains.
- $\mu$ is **Marquardt damping**, starting at $10^{-9}$ and multiplied by 100
  whenever no step at that level is accepted.
- The candidate $v + t\,\delta$ is **projected** (§5, §6) and then accepted
  only if it lowers $\mathcal{F}$, with $t$ halved up to ten times. So every
  iterate is feasible and no worse than the last, and if no step improves the
  fit it is stationary and the loop stops. The fit cannot return something
  worse than its initial estimate — which is exactly what the alternating
  version did.

Near the optimum this converges quadratically. A representative trace for the
true 60 → 120 at $i = 0.7$:

| iteration | $\mathcal{F}$        | $\tau_0 \to \tau_1$ | $i$   |
| --------- | -------------------- | ------------------- | ----- |
| 0         | $7.8{\times}10^{4}$  | 56.72 → 112.67      | 0.602 |
| 1         | $1.4{\times}10^{4}$  | 60.76 → 118.31      | 0.711 |
| 2         | $6.7{\times}10^{1}$  | 60.00 → 119.92      | 0.699 |
| 3         | $3.5{\times}10^{-4}$ | 60.00 → 120.00      | 0.700 |
| 4         | $4.4{\times}10^{-7}$ | 60.00 → 120.00      | 0.700 |

### 4.3 Where global information enters

Gauss–Newton is local, and the shape is the parameter with a basin to find.
Each shape is chosen once at initialisation, and again whenever the joint step
stalls, by a deterministic 1-D search: a 32-point grid over $[0.02, 0.98]$,
then golden-section refinement inside the bracketing interval. A re-seeded
shape is kept only if it lowers $\mathcal{F}$.

A grid is enough because the landscape does not need more. Every residual is
strictly monotone in $i_m$: $p = \ln\tfrac12/\ln i_m$ increases with $i_m$,
$\varphi(x) = x^{p}$ decreases in $p$ on $(0,1)$, so the modelled elapsed time
moves one way in $i_m$ at every interior position and the other way for the
opposite direction of travel. A sum of squares of co-monotone residuals has
its minimum where their weighted average changes sign, and a bracketing grid
finds it. What this replaces was 500 steps of simulated annealing on the first
pass — insurance against a multi-modality that, with the objective settled, is
not there. Nothing in the fit is random any more.

### 4.4 Banded Cholesky

The system is stored as $\texttt{band}[d][i] = A(i, i+d)$ for $d \in \{0,1,2\}$
and factored as $A = R^{\mathsf T}R$ with $R$ upper triangular in the same
storage. A non-positive pivot returns `null` rather than a plausible-looking
vector out of an unstable elimination, and the caller damps harder and retries.

---

## 5. Direction constraints

For each segment the initial regression (§2.2) estimates an endpoint delta
$\Delta \tau_m = \tau_{m+1} - \tau_m$, which over a normalised $x$ is the
regression slope. A direction is locked only if that slope clears **two** bars:

$$
|\Delta \tau_m| \;\ge\; 1\ \text{BPM}
\qquad\text{and}\qquad
|\Delta \tau_m| \;\ge\; 2\,\operatorname{se}(\Delta \tau_m),
\qquad
\operatorname{se}^2 = \frac{\sum_j w_j r_j^2}{n-2}\cdot\frac{\sum_j w_j}{\det}.
$$

The size test alone is not a test of confidence — three IOIs scattered over
40 BPM produce a large slope routinely, and the direction it points is noise.
A segment with fewer than three points has no residual degrees of freedom, so
its standard error is infinite and its direction stays `auto`: two points
always make a perfect line, and a perfect line is not evidence.

A locked segment is held to $\tau_{m+1} - \tau_m \ge \delta$ (acc) or
$\le -\delta$ (rit) with $\delta = 0.1$ BPM, by the weighted least-change
projection

$$
\min_{\tau'} \; w_m(\tau_m' - \tau_m)^2 + w_{m+1}(\tau_{m+1}' - \tau_{m+1})^2
\quad \text{s.t. the constraint,}
$$

with boundary weights from adjacent segment data density, swept forward and
backward until no violation remains. This projection runs **inside** the line
search, so what the search compares is the objective on states the fit could
actually return. It used to run outside the solve, including once more after
the loop had ended, where nothing measured what it cost.

---

## 6. Turning pairs

At a sign-change boundary (rit→acc or acc→rit) with both deltas at least
2 BPM, the two shapes are coupled toward $i_{m} + i_{m+1} = 1$ by a proximal
step and then held strictly either side of $0.5$ by a margin of $0.02$. This
is a musical prior — a rounded gesture rather than a cusp — and not a
statement about the data.

The joint step has to know about it. A Gauss–Newton direction that does not
know its shape component is about to be overruled spends that component on a
move that is then undone; the candidate misses on both counts, the line search
rejects every step size, and the fit is left stationary at boundary tempos
chosen for shapes it no longer has. On a linear 100 → 70 → 110 valley that was
the entire error: the tempos came back within 0.02 BPM of the truth and the
onsets were 32 ms out, because the only thing wrong was two shapes nudged to
0.48 and 0.52 that nothing was allowed to answer. Held out of the step — their
Jacobian column zeroed and the rank floor pointed at their current value —
those shapes stay where the prior put them and every tempo adapts around them.
The same case then measures 3.0 ms, which is what the prior itself costs when
the truth is linear on both sides of a turn.

The data still gets its say through §4.3, which re-proposes those shapes at the
current tempos and keeps the proposal only if it lowers $\mathcal{F}$.

---

## 7. What this does not fix

The fitter reproduces the onsets it is given. When those onsets have already
been warped by something the tempo map is not responsible for — rubato, above
all — a better tempo fit explains _more_ of that warp as tempo and leaves the
next fitter in the chain a residual that is no longer the thing it is built to
describe. Over a fitting window 1.75 rubato frames long, a steady 120 BPM
comes back as 54 → 128. The round-trip suite records this on three cases; the
defect is fitting tempo and rubato in sequence, not the tempo fit.

---

## References

Berndt, A. (2011). _Musical Tempo Curves._ Proceedings of the
International Computer Music Conference (ICMC), Huddersfield.
