import {
  getInstructions,
  type InstructionOptions,
  Mpm,
  removeInstruction,
  requireMap,
  type Scope,
} from '../../src/mpm/index.js';
import { Alignment } from '../../src/alignment/index.js';
import {
  AbstractTransformer,
  generateId,
  type ScopedTransformationOptions,
} from '../../src/transformers/Transformer.js';

interface InsertTempoOptions extends ScopedTransformationOptions {
  from: number;
  to: number;
  bpm: number;
  transitionTo?: number;
  meanTempoAt?: number;
  beatLength: number;
}

export class InsertTempo extends AbstractTransformer<InsertTempoOptions> {
  readonly name = 'InsertTempo';
  readonly requires = [];
  private _boundaryId?: string;

  constructor(options?: InsertTempoOptions) {
    super(options || { scope: 'global', from: 0, to: 0, bpm: 120, beatLength: 0.25 });
  }

  protected override disowned(): readonly string[] {
    return this._boundaryId ? [this._boundaryId] : [];
  }

  protected transform(msm: Alignment, mpm: Mpm): void {
    this._boundaryId = undefined;
    msm.shiftToFirstOnset();
    const { from, to, bpm, transitionTo, meanTempoAt, beatLength } = this.options;
    const scope = this.options.scope;

    this.removeAffectedTempoInstructions(mpm, scope, from, to);

    const tempo: InstructionOptions<'tempo'> = {
      id: generateId('tempo', from, mpm),
      date: from,
      bpm,
      beatLength,
      ...(transitionTo !== undefined
        ? {
            transitionTo,
            meanTempoAt: meanTempoAt ?? 0.5,
          }
        : {}),
    };

    requireMap(mpm, 'tempo', scope).addTempo(tempo);
  }

  private removeAffectedTempoInstructions(mpm: Mpm, scope: Scope, from: number, to: number) {
    const existing = getInstructions(mpm, 'tempo', scope)
      .slice()
      .sort((a, b) => a.date - b.date);
    if (existing.length === 0) return;

    const isCovered = (date: number) => date >= from && date < to;

    const boundary = to;
    if (!existing.some((t) => t.date === boundary)) {
      const effectiveIndex = findEffectiveTempoIndex(existing, boundary);
      if (effectiveIndex !== -1) {
        const effectiveTempo = existing[effectiveIndex];
        if (isCovered(effectiveTempo.date)) {
          const restore: InstructionOptions<'tempo'> = {
            id: generateId('tempo', boundary, mpm),
            date: boundary,
            beatLength: effectiveTempo.beatLength,
            bpm: effectiveTempo.bpm,
          };
          this._boundaryId = restore.id;
          for (const t of existing) {
            if (isCovered(t.date)) removeInstruction(mpm, t);
          }
          requireMap(mpm, 'tempo', scope).addTempo(restore);
          return;
        }
      }
    }

    for (const t of existing) {
      if (isCovered(t.date)) removeInstruction(mpm, t);
    }
  }
}

function findEffectiveTempoIndex(tempos: readonly { date: number }[], date: number): number {
  let result = -1;
  for (let i = 0; i < tempos.length; i++) {
    if (tempos[i].date <= date) result = i;
    else break;
  }
  return result;
}
