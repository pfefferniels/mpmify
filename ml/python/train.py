"""Train the tempo model (CPU, length-bucketed batches, packed tensors).

Usage: python3 train.py [epochs] [run_name] [mode] [flags]
Expects data/train.pt and data/val.pt (see preprocess.py; val needs --eval).

Flags (all stripped before the positionals are read, so order does not matter):
  --device cpu|cuda|auto   --threads N
  --head-weight W          weight of the v4 per-note head loss (default 1.0)
  --limit N                use only the first N pieces of each split
  --max-steps N            stop after N optimiser steps; implies no checkpoint, no eval
                           (a smoke run must not overwrite a real run's checkpoint)
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
from model import PEDAL_SCALE, VEL_CHANGE_SCALE, TempoTransformer
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

#: Weight of the per-note head objective against the token cross-entropy. The four head
#: terms are each normalised to O(0.1-1) at init (see model.VEL_CHANGE_SCALE), so 1.0 means
#: "the heads matter about as much as the decoder" rather than an arbitrary scale.
HEAD_W = 1.0
if "--head-weight" in sys.argv:
    _i = sys.argv.index("--head-weight")
    HEAD_W = float(sys.argv[_i + 1])
    del sys.argv[_i : _i + 2]

# Smoke flags. `--max-steps` also suppresses checkpointing and the final eval: a short run
# under a real run's name would otherwise overwrite its checkpoint with 20 steps of training.
LIMIT = None
if "--limit" in sys.argv:
    _i = sys.argv.index("--limit")
    LIMIT = int(sys.argv[_i + 1])
    del sys.argv[_i : _i + 2]
MAX_STEPS = None
if "--max-steps" in sys.argv:
    _i = sys.argv.index("--max-steps")
    MAX_STEPS = int(sys.argv[_i + 1])
    del sys.argv[_i : _i + 2]
#: a 20-step smoke never reaches step 100, and its whole point is watching the components move
LOG_EVERY = 1 if MAX_STEPS else 100

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
if LIMIT:
    for _split in (train, val):
        for _k, _v in _split.items():
            if isinstance(_v, list):
                _split[_k] = _v[:LIMIT]
n_train = len(train["feats"])
# v4 phase 2: the hybrid's per-note half. The packed set carries `note_labels` only if it
# was preprocessed after they existed, so the arm is data-driven -- a v4 run on an older
# pack trains the decoder alone, exactly as before.
HEADS = V4 and bool(train.get("note_labels"))
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
    """``(x, x_pad_mask, y)``, plus the packed per-note labels when the heads are on.

    Label rows are ``[artic_present, relative_duration, velocity_change, pedal_state]``
    (``dataset.piece_to_note_labels_v4``), padded to the batch's longest piece; padded
    positions are masked out by ``~x_pad_mask``, the same mask the encoder uses, so a
    padded note can never contribute to a head loss.
    """
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
    if not HEADS:
        return x, xm, y, None
    lab = torch.zeros(B, max_n, 4)
    for i, idx in enumerate(idxs):
        li = train["note_labels"][idx]
        lab[i, : li.shape[0]] = li
    return x, xm, y, lab


def head_losses(heads, lab, valid):
    """The four per-note terms, each already on a comparable scale.

    ``artic_present`` is a BCE over every real note; ``rel_dur`` and ``vel_change`` are L1
    over the **truly articulated** notes only -- the label is 1.0/0.0 (the neutral value)
    everywhere else, so training the regressors on the other 85 % of notes would teach them
    the marginal "no articulation" constant instead of the attribute. ``pedal_state`` is L1
    over every note, in the [0,1] domain the head regresses in.

    Returns ``(bce, l1_reldur, l1_vel, l1_pedal)``; a batch with no articulated note at all
    yields exact 0.0 for the two masked terms rather than a NaN from an empty mean.
    """
    present = lab[..., 0]
    artic = valid & (present > 0.5)
    n_artic = artic.sum().clamp(min=1)
    bce = nn.functional.binary_cross_entropy_with_logits(
        heads["artic_logit"][valid], present[valid])
    l1_reldur = ((heads["rel_dur"] - lab[..., 1]).abs() * artic).sum() / n_artic
    l1_vel = (((heads["vel_change"] - lab[..., 2]).abs() * artic).sum()
              / n_artic / VEL_CHANGE_SCALE)
    l1_pedal = ((heads["pedal_state"] - lab[..., 3]).abs()[valid]).mean() / PEDAL_SCALE
    return bce, l1_reldur, l1_vel, l1_pedal


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
if HEADS:
    MODEL_CFG["heads"] = True
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
    # `heads` is compared with a default of False on BOTH sides, and deliberately does not
    # get the "tolerate an absent key" treatment the other keys get: a checkpoint written
    # before the per-note heads existed was trained WITHOUT them, so treating its missing
    # key as "whatever this run wants" would let a phase-1 v4 checkpoint resume silently
    # into a heads run -- adding an untrained 4-output MLP mid-schedule and reporting the
    # result as a continuation. The other keys keep the tolerant rule, which exists for
    # checkpoints written before n_features/vocab_size were recorded at all.
    cfg_ok = (prev_cfg.get("heads", False) == MODEL_CFG.get("heads", False)
              and all(prev_cfg.get(k, MODEL_CFG[k]) == MODEL_CFG[k]
                      for k in MODEL_CFG if k != "heads"))
    if cfg_ok:
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
        x, xm = x.to(device), xm.to(device)
        out = model.greedy_decode(x, xm, max_len=MAX_DECODE).cpu()
        # One extra encoder pass for the per-note bands. The heads are read here rather
        # than inside greedy_decode so the decoder's own path stays untouched.
        note_out = None
        if HEADS:
            h = model.note_heads(x, xm)
            note_out = {"artic_present": torch.sigmoid(h["artic_logit"]).cpu(),
                        "rel_dur": h["rel_dur"].cpu(),
                        "vel_change": h["vel_change"].cpu(),
                        "pedal_state": h["pedal_state"].cpu()}
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
                note_pred = None
                if note_out is not None:
                    n_notes = val["feats"][i].shape[0]
                    note_pred = {k: v[j, :n_notes].tolist() for k, v in note_out.items()}
                metrics.append(evaluate_piece_v4(pred_maps, rec, note_pred=note_pred))
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
    comp_sum = [0.0] * 4
    comp_n = 0
    stop = False
    for bi, idxs in enumerate(batches):
        step += 1
        for g in opt.param_groups:
            g["lr"] = lr_at(step)
        x, xm, y, lab = make_batch(idxs)
        x, xm, y = x.to(device), xm.to(device), y.to(device)
        if HEADS:
            logits, heads = model(x, xm, y[:, :-1], return_heads=True)
        else:
            logits = model(x, xm, y[:, :-1])
        ce = crit(logits.reshape(-1, logits.shape[-1]), y[:, 1:].reshape(-1))
        loss = ce
        if HEADS:
            comps = head_losses(heads, lab.to(device), ~xm)
            loss = ce + HEAD_W * sum(comps)
            comp_sum = [s + float(c.detach()) for s, c in zip(comp_sum, comps)]
            comp_n += 1
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        ntok = int((y[:, 1:] != PAD).sum())
        # the logged `loss` stays the token CE alone, as in v1-v3, so the number means the
        # same thing across runs; the head terms are reported next to it, not folded in
        tot_loss += float(ce.detach()) * ntok
        tot_tok += ntok
        if step % LOG_EVERY == 0:
            extra = ""
            if comp_n:
                b, r, v, p = (s / comp_n for s in comp_sum)
                extra = (f" | head bce {b:.4f} relDur {r:.4f} velCh {v:.4f} "
                         f"pedal {p:.4f} (w {HEAD_W})")
                comp_sum, comp_n = [0.0] * 4, 0
            log(f"epoch {epoch} step {step}/{total_steps} loss {tot_loss/tot_tok:.4f} "
                f"({(time.time()-t0)/(bi+1):.2f}s/step){extra}")
            tot_loss = tot_tok = 0
        if MAX_STEPS and step >= MAX_STEPS:
            stop = True
            break
    if stop:
        # smoke run: no checkpoint, no eval -- see the --max-steps note at the top
        log(f"SMOKE_COMPLETE after {step} steps ({time.time()-t0:.0f}s)")
        break
    msg = f"EPOCH {epoch} DONE ({time.time()-t0:.0f}s)"
    if epoch % EVAL_EVERY == EVAL_EVERY - 1 or epoch == EPOCHS - 1:
        med = run_eval()
        if V4:
            msg += (f" val: exact={med['exact']:.2f} "
                    f"render_rmse={med['render_rmse']:.1f}ms (base {med['base_render_rmse']:.1f}ms) "
                    f"off_rmse={med['off_rmse']:.1f}ms (base {med['base_off_rmse']:.1f}ms) "
                    f"vel_rmse={med['vel_rmse']:.2f} (base {med['base_vel_rmse']:.2f}) "
                    f"cc_rmse={med['cc_rmse']:.2f} (base {med['base_cc_rmse']:.2f}) "
                    f"cc64={med['cc64_agree']:.2f} (base {med['base_cc64_agree']:.2f}) "
                    f"asyn_err={med['asyn_offset_err']:.1f}ms (base {med['base_asyn_offset_err']:.1f}ms) "
                    f"boundary_f1={med['boundary_f1']:.2f} rubato_f1={med['rubato_f1']:.2f} "
                    f"mdl_ratio={med['mdl_ratio']:.2f} nonfinite={med['n_nonfinite']:.1f} "
                    f"n_pred={med['n_pred']} n_gt={med['n_gt']}")
            if HEADS:
                msg += (f" | heads: artic_f1={med['artic_note_f1']:.2f} "
                        f"(P {med['artic_note_prec']:.2f} R {med['artic_note_rec']:.2f}) "
                        f"relDur_mae={med['artic_reldur_mae']:.3f} "
                        f"velCh_mae={med['artic_vel_mae']:.2f} "
                        f"pedal_mae={med['pedal_state_mae']:.1f}cc "
                        f"n_artic={med['n_artic_pred']:.0f}/{med['n_artic_gt']:.0f}")
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

if not MAX_STEPS:
    with open(run_dir / "final_val.json", "w") as f:
        json.dump(run_eval(min(500, len(val["feats"]))), f, indent=2)
    log("TRAINING_COMPLETE")
