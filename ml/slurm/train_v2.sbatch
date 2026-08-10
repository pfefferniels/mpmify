#!/bin/bash
# fenby v1.0 (model_v2) training on bwUniCluster 3.0.
#
# Differs from train.sbatch in exactly one way that matters: the architecture comes from a
# JSON run config, not from the code, and that config is stored inside every checkpoint.
# CONFIG is therefore MANDATORY — there is no default, because a defaulted architecture is
# a run that cannot be reproduced from its own record.
#
#   sbatch --export=ALL,RUN=v2-base,CONFIG=configs/base.json,EPOCHS=96,MODE=v41 \
#          ml/slurm/train_v2.sbatch
#   sbatch --export=ALL,RUN=v2-large,CONFIG=configs/large.json,EPOCHS=96,MODE=v41 \
#          -t 12:00:00 ml/slurm/train_v2.sbatch
#   sbatch -p dev_gpu_h100 -t 00:30:00 \
#          --export=ALL,RUN=v2-smoke,CONFIG=configs/base.json,EXTRA="--max-steps 50" \
#          ml/slurm/train_v2.sbatch
#
# CPU reference run (override the GPU directives on the command line; #SBATCH lines cannot
# be conditional):
#   sbatch -p cpu --gres=NONE -c 32 -t 12:00:00 \
#          --export=ALL,RUN=v2-base-cpuref,CONFIG=configs/base.json,DEVICE=cpu,THREADS=32 \
#          ml/slurm/train_v2.sbatch
#
# GATE THE FIRST FOUR LOG LINES. They are written before the first optimiser step and are
# the whole pre-flight:
#   line 1  config=... arch=model_v2 ... feat=16-excl[14:pedal_state] params=<4.28M|44.97M>
#   line 2  ... seed=0 ... heads=on w=1.0 [config] ... f14_pedal=EXCLUDED (leak fix)
#   line 3  defaults taken: model{} train{}   [| cli overrides: ...]
#   line 4  pedal index: f14 (pedal_state) verified against dataset.py: ...
# `heads=OFF` cannot happen with the shipped configs (model.heads=true aborts on a pack
# without note_labels) and `f14_pedal=INPUT` cannot happen without allow_pedal_leak — both
# failure modes that used to be eyeball-gated are now aborts, but read the lines anyway:
# they also state the parameter count, the batch count, the seed and the LR schedule the run
# will use. Line 3 is empty braces for both shipped configs: a key that fell back to a
# documented default would be named there rather than taken in silence. Line 4 re-derives
# the pedal column by RUNNING dataset.py's extractor, so a re-preprocessed pack that moved
# the column aborts instead of training a leaking model under an "EXCLUDED" banner.
#
# THE PORT GATE for RUN=v2-base is runs/v41-asyn-h100 as re-scored by the truthful evaluator
# (final_val.fixed.json, epoch 95, 1000 pieces): render 635.4 ms / vel 5.63 / asyn 7.25 ms /
# artic F1 1.00 / boundary 0.67. NOT the 771.6 / 6.28 / 5.6 of LOG.md's 19:45 verdict table,
# which the re-eval supersedes — a v2-base landing near 700 ms would read as "port clean"
# against those and as a port defect against the record. The numbers live in base.json's
# `_gate` block and tests_model_v2.py check `gate` asserts them against the file itself.
# pedal_state_mae is deliberately NOT part of the gate: with f14 excluded the head is
# measured on something the v4 runs never measured (their 0.34 cc was largely self-copy).
#
# train_v2.py resolves data and checkpoints relative to ml/python, so we cd there.
# Checkpoints land in ml/runs/<RUN>/ckpt.pt every epoch; a killed job resumes by resubmitting
# the identical command. The resume guard is STRICT and covers BOTH the architecture and the
# schedule (epochs, batch, lr, warmup, weight_decay, head_weight, clip, seed): any difference
# aborts with a printed diff, so editing a config file — or adding EXTRA="--batch 8" — and
# resubmitting the same RUN is a refusal, not a silent change. Evaluation-only keys
# (eval_pieces, eval_every, decode_batch, final_eval_pieces) are logged instead of refused.
# Note that a checkpoint written before the schedule guard existed carries no `train_config`
# and is refused on resume; those are smoke runs only, so use a new RUN name.
#
#SBATCH --job-name=fenby
#SBATCH --partition=gpu_h100
#SBATCH --gres=gpu:1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --time=08:00:00
#SBATCH --output=slurm-logs/%x-%j.out
#SBATCH --mail-type=END,FAIL
#SBATCH --mail-user=niels.pfeffer@gmail.com

set -euo pipefail

WS=/pfs/work9/workspace/scratch/tu_amipf01-ml
REPO="$WS/mpmify-ml"

RUN="${RUN:-}"
CONFIG="${CONFIG:-}"
EPOCHS="${EPOCHS:-96}"
MODE="${MODE:-v41}"
DEVICE="${DEVICE:-cuda}"
# Only meaningful on cpu; train_v2.py ignores --threads on cuda. 32 rather than the node's
# full core count: torch CPU training saturates well below it.
THREADS="${THREADS:-32}"
# escape hatch for smokes: EXTRA="--max-steps 50" or EXTRA="--limit 200 --batch 8"
EXTRA="${EXTRA:-}"

if [ -z "$RUN" ] || [ -z "$CONFIG" ]; then
    echo "ABORT: RUN and CONFIG are required, e.g." >&2
    echo "  sbatch --export=ALL,RUN=v2-base,CONFIG=configs/base.json ml/slurm/train_v2.sbatch" >&2
    exit 2
fi

module load devel/python/3.13.3-gnu-14.2
PY="$HOME/venvs/ml-cu128/bin/python"

mkdir -p "$REPO/slurm-logs"
cd "$REPO/python"

if [ ! -f "$CONFIG" ]; then
    echo "ABORT: config $CONFIG not found under $(pwd)" >&2
    exit 2
fi

echo "=== $(date -Is) job $SLURM_JOB_ID on $(hostname) ==="
echo "run=$RUN config=$CONFIG epochs=$EPOCHS mode=$MODE device=$DEVICE extra='$EXTRA'"
echo "--- config as submitted ---"
cat "$CONFIG"
echo "---------------------------"
# The tests are seconds and they are the difference between a bad build and a bad result:
# parameter parity with model.py, the exact f14-exclusion floor, the pedal column re-derived
# from dataset.py, the causal/padding floors, head_losses equality with train.py, end-to-end
# seed reproducibility, the schedule-aware resume guard and the port gate checked against
# runs/v41-asyn-h100/final_val.fixed.json. A failure here must not become a 96-epoch run.
# (`gate` prints SKIP for its numeric half if that run directory is not in the workspace.)
"$PY" tests_model_v2.py

if [ "$DEVICE" = "cuda" ]; then
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
    srun "$PY" train_v2.py "$EPOCHS" "$RUN" "$MODE" --config "$CONFIG" --device cuda $EXTRA
else
    echo "cpu cores allocated: ${SLURM_CPUS_PER_TASK:-?}, threads=$THREADS"
    srun "$PY" train_v2.py "$EPOCHS" "$RUN" "$MODE" --config "$CONFIG" \
         --device cpu --threads "$THREADS" $EXTRA
fi

echo "=== $(date -Is) done ==="
