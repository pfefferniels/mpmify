#!/bin/bash
# mpmify MPM-generation training on bwUniCluster 3.0.
#
#   sbatch ml/slurm/train.sbatch                                      # defaults below
#   sbatch --export=ALL,RUN=v4-h100,EPOCHS=24,MODE=v4 ml/slurm/train.sbatch
#   sbatch -p dev_gpu_h100 -t 00:30:00 --export=ALL,RUN=smoke,EPOCHS=1 ml/slurm/train.sbatch
#
# train.py is positional (EPOCHS RUN MODE) with --device stripped before parsing,
# and resolves data/checkpoints relative to ml/python — so we cd there.
# Checkpoints land in ml/runs/<RUN>/ckpt.pt every epoch; a killed job resumes by
# resubmitting the identical command (config-guarded).
#
#SBATCH --job-name=mpmify
#SBATCH --partition=gpu_h100
#SBATCH --gres=gpu:1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --time=04:00:00
#SBATCH --output=slurm-logs/%x-%j.out
#SBATCH --mail-type=END,FAIL
#SBATCH --mail-user=niels.pfeffer@gmail.com

set -euo pipefail

WS=/pfs/work9/workspace/scratch/tu_amipf01-ml
REPO="$WS/mpmify-ml"

RUN="${RUN:-v4-h100}"
EPOCHS="${EPOCHS:-24}"
MODE="${MODE:-v4}"

module load devel/python/3.13.3-gnu-14.2
PY="$HOME/venvs/ml-cu128/bin/python"

mkdir -p "$REPO/slurm-logs"
cd "$REPO/python"

echo "=== $(date -Is) job $SLURM_JOB_ID on $(hostname) ==="
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
echo "run=$RUN epochs=$EPOCHS mode=$MODE"

srun "$PY" train.py "$EPOCHS" "$RUN" "$MODE" --device cuda

echo "=== $(date -Is) done ==="
