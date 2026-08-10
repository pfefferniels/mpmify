"""Train the tempo model (CPU, length-bucketed batches, packed tensors).

Usage: python3 train.py [epochs] [run_name]
Expects data/train.pt and data/val.pt (see preprocess.py; val needs --eval).
"""

import json
import math
import random
import statistics
import sys
import time
from pathlib import Path

import torch
import torch.nn as nn

from dsl import (PAD, V1_VOCAB_SIZE, V2_VOCAB_SIZE, V3_VOCAB_SIZE, V4_VOCAB_SIZE,
                 decode_tokens, decode_piece, decode_piece_v3, decode_piece_v4)
from evaluate import (evaluate_piece, evaluate_piece_v2, evaluate_piece_v3,
                      evaluate_piece_v4)
from model import TempoTransformer
from dataset import (N_FEATURES, N_FEATURES_V2, N_FEATURES_V31, N_FEATURES_V4)

# flags are stripped before positional parsing, so `train.py 24 v4 v4 --device cuda`
# and `train.py --device cuda 24 v4 v4` both work and the positional contract is unchanged
DEVICE_ARG = "cpu"
if "--device" in sys.argv:
    _i = sys.argv.index("--device")
    DEVICE_ARG = sys.argv[_i + 1]
    del sys.argv[_i : _i + 2]
    if DEVICE_ARG not in ("cpu", "cuda", "auto"):
        raise SystemExit(f"--device must be cpu|cuda|auto, got {DEVICE_ARG}")

THREADS = 4
if "--threads" in sys.argv:
    _i = sys.argv.index("--threads")
    THREADS = int(sys.argv[_i + 1])
    del sys.argv[_i : _i + 2]

EPOCHS = int(sys.argv[1]) if len(sys.argv) > 1 else 10
RUN = sys.argv[2] if len(sys.argv) > 2 else "v1"
MODE = sys.argv[3] if len(sys.argv) > 3 else "v1"
V4 = MODE == "v4"
V31 = MODE == "v31"
V3 = MODE == "v3" or V31
V2 = MODE == "v2" or V3
# Per-mode and set by measurement, not by analogy. v4 pieces are ~2.4x longer than v3.1's
# (median 114 notes vs 51), but peak RSS turned out flat in the batch size -- 0.67-0.69 GB
# from 24 to 48 on the worst length bucket -- so memory does not bind here and 48 is the
# largest size measured with margin. 20k pieces at 48 is 417 batches/epoch, close enough to
# v3.1's 313 that the LR schedule carries over. See the sweep in ml/LOG.md.
BATCH = 48 if V4 else 64
LR = 3e-4
WARMUP = 300
EVAL_PIECES = 100
EVAL_EVERY = 2

if DEVICE_ARG == "auto":
    DEVICE_ARG = "cuda" if torch.cuda.is_available() else "cpu"
device = torch.device(DEVICE_ARG)
if device.type == "cpu":
    # default 4 = the local (M1) configuration; cluster CPU nodes pass --threads N
    torch.set_num_threads(THREADS)
else:
    # TF32 on cuda only: ~order-of-magnitude matmul speedup on H100/A100; never enabled
    # on cpu so the local reference path keeps exact fp32 semantics
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
run_dir = Path("../runs") / RUN
run_dir.mkdir(parents=True, exist_ok=True)
log_f = open(run_dir / "log.txt", "a")


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    log_f.write(line + "\n")
    log_f.flush()


SUFFIX = "_v4" if V4 else ("_v31" if V31 else ("_v3" if V3 else ("_v2" if V2 else "")))
train = torch.load(f"../data/train{SUFFIX}.pt")
val = torch.load(f"../data/val{SUFFIX}.pt")
n_train = len(train["feats"])
N_FEAT = (N_FEATURES_V4 if V4 else
          (N_FEATURES_V31 if V31 else (N_FEATURES_V2 if V2 else N_FEATURES)))
# v4's target is the tempo+dynamics+rubato+asynchrony subset of CANONICAL §11 (median 184
# tokens, p90 250 on the pilot); articulation and movement are per-note heads, not tokens.
# The packed set records the ceiling it was built at -- decoding shorter than the data was
# packed truncates long targets with nothing in the metrics to show for it.
MAX_DECODE = train.get("max_tgt") or (320 if V4 else (448 if V3 else (320 if V2 else 224)))

# length-bucketed batches: sort by note count, batch contiguously, shuffle batch order
order = sorted(range(n_train), key=lambda i: train["feats"][i].shape[0])
batches = [order[i : i + BATCH] for i in range(0, n_train, BATCH)]


def make_batch(idxs):
    fs = [train["feats"][i] for i in idxs]
    ts = [train["tgts"][i].long() for i in idxs]
    max_n = max(f.shape[0] for f in fs)
    max_t = max(t.shape[0] for t in ts)
    B = len(fs)
    x = torch.zeros(B, max_n, N_FEAT)
    xm = torch.ones(B, max_n, dtype=torch.bool)
    y = torch.full((B, max_t), PAD, dtype=torch.long)
    for i, (f, t) in enumerate(zip(fs, ts)):
        x[i, : f.shape[0]] = f
        xm[i, : f.shape[0]] = False
        y[i, : t.shape[0]] = t
    return x, xm, y


# explicit per-version vocab freeze — NEVER bare len(VOCAB) for old versions
# (appending tokens for a new version must not desync resumable checkpoints)
VOCAB_SIZES = {"v1": V1_VOCAB_SIZE, "v2": V2_VOCAB_SIZE, "v3": V3_VOCAB_SIZE,
               "v4": V4_VOCAB_SIZE}
VERSION = "v4" if V4 else ("v3" if V3 else ("v2" if V2 else "v1"))
if V31 or V4:  # moderate capacity bump alongside the conditioning features
    MODEL_CFG = {"d_model": 192, "nhead": 8, "enc_layers": 4, "dec_layers": 4, "ff": 768,
                 "n_features": N_FEAT, "vocab_size": VOCAB_SIZES[VERSION]}
else:
    MODEL_CFG = {"d_model": 160, "nhead": 8, "enc_layers": 3, "dec_layers": 3, "ff": 640,
                 "n_features": N_FEAT, "vocab_size": VOCAB_SIZES[VERSION]}
model = TempoTransformer(dropout=0.1, **MODEL_CFG)
model = model.to(device)
opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=0.01)
crit = nn.CrossEntropyLoss(ignore_index=PAD)
total_steps = EPOCHS * len(batches)
step = 0

start_epoch = 0
ck_path = run_dir / "ckpt.pt"
if ck_path.exists():
    prev = torch.load(ck_path, map_location="cpu")
    prev_cfg = prev.get("config") or {}
    # tolerate older ckpts without n_features/vocab_size keys
    if all(prev_cfg.get(k, MODEL_CFG[k]) == MODEL_CFG[k] for k in MODEL_CFG):
        model.load_state_dict(prev["model"])
        if "opt" in prev:
            opt.load_state_dict(prev["opt"])
        start_epoch = prev["epoch"] + 1
        step = start_epoch * len(batches)
        print(f"resuming from epoch {start_epoch}")
    else:
        # a config mismatch on an existing run dir means silent-overwrite danger:
        # refuse instead of restarting from scratch over a live checkpoint
        raise SystemExit(
            f"ABORT: {ck_path} exists but its config {prev_cfg} does not match "
            f"{MODEL_CFG}. Use a new run name or delete the checkpoint explicitly."
        )


def lr_at(s):
    if s < WARMUP:
        return LR * s / WARMUP
    return LR * 0.5 * (1 + math.cos(math.pi * min(1.0, (s - WARMUP) / total_steps)))


@torch.no_grad()
def run_eval(n_pieces=EVAL_PIECES, decode_batch=50):
    model.eval()
    n = min(n_pieces, len(val["feats"]))
    metrics = []
    exact = 0
    for lo in range(0, n, decode_batch):
        idxs = range(lo, min(lo + decode_batch, n))
        fs = [val["feats"][i] for i in idxs]
        max_n = max(f.shape[0] for f in fs)
        x = torch.zeros(len(fs), max_n, N_FEAT)
        xm = torch.ones(len(fs), max_n, dtype=torch.bool)
        for j, f in enumerate(fs):
            x[j, : f.shape[0]] = f
            xm[j, : f.shape[0]] = False
        out = model.greedy_decode(x.to(device), xm.to(device), max_len=MAX_DECODE).cpu()
        for j, i in enumerate(idxs):
            ids = [t for t in out[j].tolist() if t != PAD]
            if ids == val["tgts"][i].long().tolist():
                exact += 1
            rec = {"notes": val["notes"][i].tolist(), "tempo": val["tempo"][i]}
            if V4:
                pred_maps, errs = decode_piece_v4(ids, subset="training")
                for k in ("dynamics", "articulation", "rubato", "movement",
                          "asynchrony", "sustain_cc", "total_ticks"):
                    if k in val:
                        rec[k] = val[k][i]
                metrics.append(evaluate_piece_v4(pred_maps, rec))
            elif V3:
                pt, pd, pa, pr, errs = decode_piece_v3(ids)
                rec["dynamics"] = val["dynamics"][i]
                rec["articulation"] = val["articulation"][i]
                rec["rubato"] = val["rubato"][i]
                metrics.append(evaluate_piece_v3(pt, pd, pa, pr, rec))
            elif V2:
                pred_tempo, pred_dyn, errs = decode_piece(ids)
                if not pred_tempo:
                    pred_tempo = [[0, 100.0, None, None]]
                rec["dynamics"] = val["dynamics"][i]
                metrics.append(evaluate_piece_v2(pred_tempo, pred_dyn, rec))
            else:
                pred_map, errs = decode_tokens(ids)
                if not pred_map:
                    pred_map = [[0, 100.0, None, None]]
                metrics.append(evaluate_piece(pred_map, rec))
    import math as _math
    med = {}
    for k in metrics[0]:
        vals = [m[k] for m in metrics
                if isinstance(m[k], (int, float)) and _math.isfinite(m[k])]
        med[k] = statistics.median(vals) if vals else float("nan")
    med["exact"] = exact / len(metrics)
    model.train()
    return med


log(f"device={device.type} train={n_train} val={len(val['feats'])} "
    f"params={sum(p.numel() for p in model.parameters())/1e6:.2f}M "
    f"epochs={EPOCHS} batches/epoch={len(batches)}")

for epoch in range(start_epoch, EPOCHS):
    model.train()
    random.seed(epoch)
    random.shuffle(batches)
    t0 = time.time()
    tot_loss = tot_tok = 0
    for bi, idxs in enumerate(batches):
        step += 1
        for g in opt.param_groups:
            g["lr"] = lr_at(step)
        x, xm, y = make_batch(idxs)
        x, xm, y = x.to(device), xm.to(device), y.to(device)
        logits = model(x, xm, y[:, :-1])
        loss = crit(logits.reshape(-1, logits.shape[-1]), y[:, 1:].reshape(-1))
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        ntok = int((y[:, 1:] != PAD).sum())
        tot_loss += float(loss.detach()) * ntok
        tot_tok += ntok
        if step % 100 == 0:
            log(f"epoch {epoch} step {step}/{total_steps} loss {tot_loss/tot_tok:.4f} "
                f"({(time.time()-t0)/(bi+1):.2f}s/step)")
            tot_loss = tot_tok = 0
    msg = f"EPOCH {epoch} DONE ({time.time()-t0:.0f}s)"
    if epoch % EVAL_EVERY == EVAL_EVERY - 1 or epoch == EPOCHS - 1:
        med = run_eval()
        if V4:
            msg += (f" val: exact={med['exact']:.2f} "
                    f"render_rmse={med['render_rmse']:.1f}ms (base {med['base_render_rmse']:.1f}ms) "
                    f"vel_rmse={med['vel_rmse']:.2f} (base {med['base_vel_rmse']:.2f}) "
                    f"cc_rmse={med['cc_rmse']:.2f} (base {med['base_cc_rmse']:.2f}) "
                    f"cc64={med['cc64_agree']:.2f} (base {med['base_cc64_agree']:.2f}) "
                    f"asyn_err={med['asyn_offset_err']:.1f}ms (base {med['base_asyn_offset_err']:.1f}ms) "
                    f"boundary_f1={med['boundary_f1']:.2f} rubato_f1={med['rubato_f1']:.2f} "
                    f"mdl_ratio={med['mdl_ratio']:.2f} nonfinite={med['n_nonfinite']:.1f} "
                    f"n_pred={med['n_pred']} n_gt={med['n_gt']}")
        elif V3:
            msg += (f" val: exact={med['exact']:.2f} "
                    f"render_rmse={med['render_rmse']:.1f}ms (base {med['base_render_rmse']:.1f}ms) "
                    f"vel_rmse={med['vel_rmse']:.2f} (base {med['base_vel_rmse']:.2f}) "
                    f"boundary_f1={med['boundary_f1']:.2f} rubato_f1={med['rubato_f1']:.2f} "
                    f"artic_f1={med['artic_f1']:.2f} mdl_ratio={med['mdl_ratio']:.2f} "
                    f"nonfinite={med['n_nonfinite']:.1f} "
                    f"n_pred={med['n_pred']} n_gt={med['n_gt']}")
        else:
            msg += (f" val: exact={med['exact']:.2f} curve_rmse={med['curve_rmse']:.4f} "
                    f"(base {med['base_curve_rmse']:.4f}) render_rmse={med['render_rmse']:.1f}ms "
                    f"(base {med['base_render_rmse']:.1f}ms) boundary_f1={med['boundary_f1']:.2f} "
                    f"n_pred={med['n_pred']} n_gt={med['n_gt']}")
            if V2:
                msg += (f" | vel_rmse={med['vel_rmse']:.2f} (base {med['base_vel_rmse']:.2f}) "
                        f"dyn_f1={med['dyn_boundary_f1']:.2f}")
    log(msg)
    torch.save({"model": model.state_dict(), "opt": opt.state_dict(),
                "epoch": epoch, "config": MODEL_CFG},
               run_dir / "ckpt.pt")

with open(run_dir / "final_val.json", "w") as f:
    json.dump(run_eval(min(500, len(val["feats"]))), f, indent=2)
log("TRAINING_COMPLETE")
