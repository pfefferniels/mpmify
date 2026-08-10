# Standing cluster queue (written 2026-08-10 ~19:30, cluster session down)

Execute top-to-bottom when bwUniCluster access revives. Self-contained; supersedes
all earlier v41/heads run requests.

## 0. Sync

- mpmify main through **30c9454** (repairs import-broken train.py; adds eval_ckpt.py).
- Re-ship BOTH pack pairs to the workspace (local Mac copies are authoritative):
  `ml/data/train_v4.pt` + `val_v4.pt` (now carry note_labels — cluster copies are stale)
  and `ml/data/train_v41.pt` + `val_v41.pt`.

## 1. Heads run (15 features)

    sbatch --export=ALL,RUN=v4-heads-h100,EPOCHS=96,MODE=v4 ml/slurm/train.sbatch

**Gate on the first log line**: must read `heads=on w=1.0`. If `heads=OFF` the pack
is stale — kill and re-sync. Fresh run name mandatory (resume guard treats heads as
config). First real heads signal: artic_f1 leaving 0.00 (epoch-2 readings
uninformative; cc metrics structurally blind to the pedal head — judged by
pedal_state_mae only).

## 2. Asynchrony-feature run (16 features; also a heads run via the pack's labels)

    sbatch --export=ALL,RUN=v41-asyn-h100,EPOCHS=96,MODE=v41 ml/slurm/train.sbatch

Same heads gate. Differs from run 1 by exactly one variable (cross-part offset
feature f15). Asynchrony answer = run 2 vs run 1: success is asyn_err < 33.6 ms
(the predicting-nothing baseline; e96 wandered 43-48). Heads answer = run 1 vs e96.

## 3. Truthful re-evaluation of existing checkpoints (from ml/python)

    python3 eval_ckpt.py --ckpt ../runs/v4-h100/ckpt.pt     --data ../data/val_v4.pt --out ../runs/v4-h100/final_val.fixed.json     --device cuda
    python3 eval_ckpt.py --ckpt ../runs/v4-h100-e96/ckpt.pt --data ../data/val_v4.pt --out ../runs/v4-h100-e96/final_val.fixed.json --device cuda
    python3 eval_ckpt.py --ckpt ../runs/<cpuref-dir>/ckpt.pt --data ../data/val_v4.pt --out ../runs/<cpuref-dir>/final_val.fixed.json --device cuda

Expect: render/vel MOVE (mis-pairing correction — old published values are void);
F1s/asyn_err/cc REPRODUCE (that agreement validates the re-eval); `mdl_ratio`
replaced by `mdl_ratio_subset` + `mdl_ratio_full`.

## Reporting

Send all first-log-lines and final_vals to the mpmify-ML orchestrator session.
