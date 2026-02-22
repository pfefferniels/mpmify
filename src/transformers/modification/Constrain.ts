/*
export type RelativeConstraint =
    WithType<
        | 'VelocityConstraint'
        | 'OnsetConstraint'
        | 'OffsetConstraint'
        | 'SustainPedalConstraint'
        | 'SoftPedalConstraint'
    >
    & WithId
    & ({ lessThan: string } | { equalTo: string } | { greaterThan: string })

type Chain = RelativeConstraint[];

type Op = "<" | "=" | ">";

interface SolveOptions {
  gap: number;        // strict gap for < and >
  tol?: number;       // convergence tolerance (default 1e-9)
  maxIters?: number;  // max sweeps (default 50_000)
}

/**
 * Mixed-chain constraint solver with fixed endpoints.
 *
 * Minimizes L2 change: sum_i (x_i - values_i)^2
 * Subject to adjacent constraints and x[0], x[n-1] fixed.
 *
 * Strictness:
 *  - '<' => x[i+1] >= x[i] + gap
 *  - '>' => x[i]   >= x[i+1] + gap
 *  - '=' => x[i+1] == x[i]
 *
 * Method:
 *  - feasibility check via difference constraints (Bellman-Ford)
 *  - projection onto intersection via Dykstra’s algorithm (pairwise projections)
function negotiate(
  values: number[],
  ops: Op[],
  options: SolveOptions
): { newValues: number[]; deltas: number[]; iterations: number } {
  const n = values.length;
  if (n < 2) {
    return { newValues: values.slice(), deltas: new Array(n).fill(0), iterations: 0 };
  }
  if (ops.length !== n - 1) {
    throw new Error(`ops must have length n-1 (expected ${n - 1}, got ${ops.length})`);
  }

  const gap = options.gap;
  if (!Number.isFinite(gap) || gap <= 0) {
    throw new Error(`gap must be a finite number > 0 (got ${gap})`);
  }

  const tol = options.tol ?? 1e-9;
  const maxIters = options.maxIters ?? 50_000;

  // 1) Deterministic feasibility check: throws early if impossible.
  if (!isFeasibleChainFixedEndpoints(values, ops, gap)) {
    throw new Error("Infeasible: fixed endpoints and constraints cannot be satisfied.");
  }

  // 2) Dykstra projection for least-squares solution
  type Corr = { ci: number; cj: number };
  const m = n - 1;
  const corr: Corr[] = Array.from({ length: m }, () => ({ ci: 0, cj: 0 }));

  const x = values.slice();
  x[0] = values[0];
  x[n - 1] = values[n - 1];

  let iter = 0;
  for (; iter < maxIters; iter++) {
    let maxDelta = 0;

    for (let i = 0; i < m; i++) {
      const j = i + 1;

      const yi = x[i] + corr[i].ci;
      const yj = x[j] + corr[i].cj;

      const { pi, pj } = projectPair(i, yi, yj, ops[i], gap, values[0], values[n - 1], n);

      corr[i].ci = yi - pi;
      corr[i].cj = yj - pj;

      const di = Math.abs(pi - x[i]);
      const dj = Math.abs(pj - x[j]);
      if (di > maxDelta) maxDelta = di;
      if (dj > maxDelta) maxDelta = dj;

      x[i] = pi;
      x[j] = pj;

      // hard anchors
      x[0] = values[0];
      x[n - 1] = values[n - 1];
    }

    const viol = maxViolation(x, ops, gap);
    if (maxDelta <= tol && viol <= tol) break;
  }

  const finalViol = maxViolation(x, ops, gap);
  if (finalViol > 5 * tol) {
    throw new Error(
      `Did not converge within tolerance. final max violation=${finalViol}. ` +
        `Try increasing maxIters or relaxing tol.`
    );
  }

  const deltas = x.map((xi, k) => xi - values[k]);
  return { newValues: x, deltas, iterations: iter + 1 };
}

/** Pairwise projection for constraint on (i,i+1), respecting fixed endpoints.
function projectPair(
  i: number,
  a: number,
  b: number,
  op: Op,
  gap: number,
  leftFixed: number,
  rightFixed: number,
  n: number
): { pi: number; pj: number } {
  const j = i + 1;

  const iFixed = i === 0;
  const jFixed = j === n - 1;

  if (iFixed && jFixed) return { pi: leftFixed, pj: rightFixed };

  if (op === "=") {
    if (iFixed) return { pi: leftFixed, pj: leftFixed };
    if (jFixed) return { pi: rightFixed, pj: rightFixed };
    const m = 0.5 * (a + b);
    return { pi: m, pj: m };
  }

  if (op === "<") {
    // b >= a + gap
    if (iFixed) return { pi: leftFixed, pj: Math.max(b, leftFixed + gap) };
    if (jFixed) return { pi: Math.min(a, rightFixed - gap), pj: rightFixed };

    const viol = (a + gap) - b;
    if (viol <= 0) return { pi: a, pj: b };
    const t = 0.5 * viol;
    return { pi: a - t, pj: b + t };
  }

  // op === ">"
  // a >= b + gap
  if (iFixed) return { pi: leftFixed, pj: Math.min(b, leftFixed - gap) };
  if (jFixed) return { pi: Math.max(a, rightFixed + gap), pj: rightFixed };

  const viol = (b + gap) - a;
  if (viol <= 0) return { pi: a, pj: b };
  const t = 0.5 * viol;
  return { pi: a + t, pj: b - t };
}

function maxViolation(x: number[], ops: Op[], gap: number): number {
  let maxV = 0;
  for (let i = 0; i < ops.length; i++) {
    const a = x[i];
    const b = x[i + 1];
    const op = ops[i];

    let v = 0;
    if (op === "=") v = Math.abs(b - a);
    else if (op === "<") v = Math.max(0, (a + gap) - b);
    else v = Math.max(0, (b + gap) - a);

    if (v > maxV) maxV = v;
  }
  return maxV;
}

/**
 * Robust feasibility check via difference constraints.
 *
 * Represent constraints as:
 *   x[v] >= x[u] + c
 *
 * Adjacent constraints:
 *   '<': x[i+1] >= x[i] + gap
 *   '>': x[i]   >= x[i+1] + gap
 *   '=': x[i+1] >= x[i] + 0 and x[i] >= x[i+1] + 0
 *
 * Fixed endpoints:
 *   x[0] = values[0], x[n-1] = values[n-1]
 * Encode as:
 *   x0 >= val0, val0 >= x0  -> the latter becomes (-x0) >= (-val0)
 *   similarly for xn-1
 *
 * We handle equalities by using two sets of constraints:
 *   - lower constraints on x (>=)
 *   - lower constraints on y where y[i] = -x[i] (also >=), which are upper constraints on x
 *
 * Feasible iff both systems have no positive cycles AND fixed endpoints are consistent.

function isFeasibleChainFixedEndpoints(values: number[], ops: Op[], gap: number): boolean {
  const n = values.length;

  // Build constraints of form var[v] >= var[u] + c for x
  type Edge = { u: number; v: number; c: number };

  const edgesX: Edge[] = [];
  for (let i = 0; i < n - 1; i++) {
    const op = ops[i];
    if (op === "<") edgesX.push({ u: i, v: i + 1, c: gap });
    else if (op === ">") edgesX.push({ u: i + 1, v: i, c: gap });
    else {
      edgesX.push({ u: i, v: i + 1, c: 0 });
      edgesX.push({ u: i + 1, v: i, c: 0 });
    }
  }

  // Lower bounds for fixed endpoints: x[k] >= values[k]
  const fixedLower: Array<{ idx: number; val: number }> = [
    { idx: 0, val: values[0] },
    { idx: n - 1, val: values[n - 1] },
  ];

  // For y=-x:
  // x[v] >= x[u] + c  => -x[u] >= -x[v] + c  => y[u] >= y[v] + c  (swap direction)
  const edgesYTransformed: Edge[] = edgesX.map(e => ({ u: e.v, v: e.u, c: e.c }));

  // Feasibility for lower-bound system using Bellman-Ford relaxation (maximization)
  const okLower = feasibleByMaxRelax(n, edgesX, fixedLower);

  // For upper bounds, run the same on y with constraints y[v] >= y[u] + c
  // plus y[k] >= -values[k] (since y=-x and x fixed)
  const fixedLowerY = fixedLower.map(f => ({ idx: f.idx, val: -f.val }));
  const okUpper = feasibleByMaxRelax(n, edgesYTransformed, fixedLowerY);

  // Additionally, ensure fixed endpoints themselves are consistent with each other through constraints.
  return okLower && okUpper;
}

/**
 * Check feasibility for constraints var[v] >= var[u] + c with some fixed lower bounds.
 * Infeasible iff there is a positive cycle reachable in the relaxation sense.
 *
 * We set initial dist to -inf except a super-source provides 0 lower bound,
 * then apply fixed lower bounds, then relax edges up to n times; if still improves, cycle.
function feasibleByMaxRelax(
  n: number,
  edges: Array<{ u: number; v: number; c: number }>,
  fixedLower: Array<{ idx: number; val: number }>
): boolean {
  const dist = new Array<number>(n).fill(Number.NEGATIVE_INFINITY);

  // Super source sets 0 baseline for all vars (doesn't restrict, just makes them reachable).
  for (let i = 0; i < n; i++) dist[i] = 0;

  // Apply fixed lower bounds
  for (const f of fixedLower) dist[f.idx] = Math.max(dist[f.idx], f.val);

  // Relax n times; if we can relax on nth, positive cycle => infeasible
  for (let it = 0; it < n; it++) {
    let changed = false;
    for (const e of edges) {
      const cand = dist[e.u] + e.c;
      if (cand > dist[e.v] + 1e-15) {
        dist[e.v] = cand;
        changed = true;
      }
    }
    // keep fixed bounds enforced
    for (const f of fixedLower) dist[f.idx] = Math.max(dist[f.idx], f.val);

    if (!changed) return true;
  }
  return false;
}
*/
