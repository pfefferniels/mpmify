"""Re-evaluate a saved checkpoint over a whole validation pack, offline.

    python3 eval_ckpt.py --ckpt ../runs/v4-h100/ckpt.pt --data ../data/val_v4.pt \
                         --out ../runs/v4-h100/final_val.fixed.json

Why this exists: `train.py` writes `final_val.json` from the evaluator that was in the
tree *at the time it ran*, so a checkpoint's published numbers are frozen against a
possibly-wrong evaluator. The v4 mis-pairing (055f8ab: `_v4_render` zipped part-major
renders against a date-major record, GT floor 8064 ms instead of 0.0) invalidated the
render and velocity metrics of every v4 run, and the mdl_ratio normalisation was priced
full-vs-full on a model that predicts a subset. Both are fixed in the tree; the numbers in
the run directories are not, and a training run cannot be repeated to refresh them.

The run is **config-driven**: the model is rebuilt from the checkpoint's own `config` dict
(including `heads`, `vocab_size`, `n_features`), never from flags, so re-evaluating cannot
silently instantiate a different architecture than the one that was trained. Two things are
cross-checked against the pack and abort rather than warn: the feature width (a v3 ckpt on a
v3.1 pack is a 10-vs-13 mismatch that torch would happily broadcast into nonsense) and the
vocabulary size.

The evaluation loop lives here rather than in `train.py` and is imported back by it, so the
epoch-end metrics and these re-evaluated ones are the same code by construction -- two
copies of a batched greedy decode plus a metric fan-out is precisely how the eval path drifts
from the training path, which is the class of bug this file was written to repair.
"""

import argparse
import json
import math
import statistics
import sys

import torch

from dsl import (PAD, V1_VOCAB_SIZE, V2_VOCAB_SIZE, V3_VOCAB_SIZE, V4_VOCAB_SIZE,
                 decode_tokens, decode_piece, decode_piece_v3, decode_piece_v4)
from evaluate import (evaluate_piece, evaluate_piece_v2, evaluate_piece_v3,
                      evaluate_piece_v4)
from model import TempoTransformer

VOCAB_SIZES = {"v1": V1_VOCAB_SIZE, "v2": V2_VOCAB_SIZE, "v3": V3_VOCAB_SIZE,
               "v4": V4_VOCAB_SIZE}
#: fallbacks for packs written before `max_tgt` was recorded in them
DEFAULT_MAX_DECODE = {"v1": 224, "v2": 320, "v3": 448, "v4": 320}

#: v4 record fields `evaluate_piece_v4` needs beyond the notes: the full map set (it renders
#: through PerfChainV4), the piece length `pos_frac` was taken from, and the pedal GT.
V4_REC_KEYS = ("dynamics", "articulation", "rubato", "movement", "asynchrony",
               "sustain_cc", "total_ticks")


@torch.no_grad()
def run_eval(model, val, *, mode, n_feat, max_decode, heads, device,
             n_pieces=None, decode_batch=50):
    """Median metrics over the first ``n_pieces`` of a packed val set (all of it by default).

    ``mode`` is ``"v1"``/``"v2"``/``"v3"``/``"v4"`` -- v3.1 evaluates as ``"v3"``, it differs
    in its features and not in its grammar. ``heads`` reads the per-note bands off the
    encoder and feeds them to the v4 evaluator, which then assembles a part-local
    articulationMap from them and renders *with* it; it requires a ``heads=True`` model and
    is ignored outside v4.
    """
    was_training = model.training
    model.eval()
    v4 = mode == "v4"
    v3 = mode == "v3"
    v2 = mode == "v2"
    heads = bool(heads and v4 and model.has_heads)
    n = len(val["feats"]) if n_pieces is None else min(n_pieces, len(val["feats"]))
    metrics = []
    exact = 0
    for lo in range(0, n, decode_batch):
        idxs = range(lo, min(lo + decode_batch, n))
        fs = [val["feats"][i] for i in idxs]
        max_n = max(f.shape[0] for f in fs)
        x = torch.zeros(len(fs), max_n, n_feat)
        xm = torch.ones(len(fs), max_n, dtype=torch.bool)
        for j, f in enumerate(fs):
            x[j, : f.shape[0]] = f
            xm[j, : f.shape[0]] = False
        x, xm = x.to(device), xm.to(device)
        out = model.greedy_decode(x, xm, max_len=max_decode).cpu()
        # One extra encoder pass for the per-note bands. The heads are read here rather than
        # inside greedy_decode so the decoder's own path stays untouched.
        note_out = None
        if heads:
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
            if v4:
                pred_maps, _errs = decode_piece_v4(ids, subset="training")
                for k in V4_REC_KEYS:
                    if k in val:
                        rec[k] = val[k][i]
                note_pred = None
                if note_out is not None:
                    n_notes = val["feats"][i].shape[0]
                    note_pred = {k: v[j, :n_notes].tolist() for k, v in note_out.items()}
                metrics.append(evaluate_piece_v4(pred_maps, rec, note_pred=note_pred))
            elif v3:
                pt, pd, pa, pr, _errs = decode_piece_v3(ids)
                rec["dynamics"] = val["dynamics"][i]
                rec["articulation"] = val["articulation"][i]
                rec["rubato"] = val["rubato"][i]
                metrics.append(evaluate_piece_v3(pt, pd, pa, pr, rec))
            elif v2:
                pred_tempo, pred_dyn, _errs = decode_piece(ids)
                if not pred_tempo:
                    pred_tempo = [[0, 100.0, None, None]]
                rec["dynamics"] = val["dynamics"][i]
                metrics.append(evaluate_piece_v2(pred_tempo, pred_dyn, rec))
            else:
                pred_map, _errs = decode_tokens(ids)
                if not pred_map:
                    pred_map = [[0, 100.0, None, None]]
                metrics.append(evaluate_piece(pred_map, rec))
    med = {}
    for k in metrics[0]:
        vals = [m[k] for m in metrics
                if isinstance(m[k], (int, float)) and math.isfinite(m[k])]
        med[k] = statistics.median(vals) if vals else float("nan")
    med["exact"] = exact / len(metrics)
    if was_training:
        model.train()
    return med


def pack_mode(val):
    """The evaluation mode a packed set implies. v3.1 packs declare themselves ``v3``."""
    if val.get("v4"):
        return "v4"
    if val.get("v3"):
        return "v3"
    if val.get("v2"):
        return "v2"
    return "v1"


def load_checkpoint(ckpt_path, val, device):
    """``(model, config)`` rebuilt from the checkpoint's own config, checked against ``val``.

    A checkpoint written before `config` was recorded at all cannot be re-evaluated safely --
    the architecture would have to be guessed from the tensor shapes and the mode from the
    file name -- so that is an abort, not a default.
    """
    ck = torch.load(ckpt_path, map_location="cpu")
    cfg = dict(ck.get("config") or {})
    if not cfg:
        raise SystemExit(f"ABORT: {ckpt_path} carries no `config`; refusing to guess the "
                         f"architecture. (Pre-config checkpoints: v0 only.)")
    mode = pack_mode(val)
    want_vocab = VOCAB_SIZES[mode]
    if cfg.get("vocab_size") != want_vocab:
        raise SystemExit(
            f"ABORT: checkpoint vocab_size {cfg.get('vocab_size')} but the pack is {mode} "
            f"(vocab {want_vocab}). A checkpoint and a pack from different versions cannot "
            f"be compared; point --data at the matching val pack.")
    got_feat = int(val["feats"][0].shape[1])
    if cfg.get("n_features") != got_feat:
        raise SystemExit(
            f"ABORT: checkpoint n_features {cfg.get('n_features')} but the pack carries "
            f"{got_feat} features per note. (v3 and v3.1 share a vocabulary and differ "
            f"exactly here -- val_v3.pt is 10, val_v31.pt is 13.)")
    model = TempoTransformer(dropout=0.1, **cfg).to(device)
    model.load_state_dict(ck["model"], strict=True)
    model.eval()
    return model, cfg, ck.get("epoch")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ckpt", required=True, help="path to ckpt.pt")
    ap.add_argument("--data", required=True, help="packed val set (preprocess.py --eval)")
    ap.add_argument("--out", required=True, help="output json (final_val.json-compatible)")
    ap.add_argument("--limit", type=int, default=None,
                    help="evaluate only the first N pieces (default: the whole pack)")
    ap.add_argument("--device", default="cpu", choices=("cpu", "cuda", "auto"))
    ap.add_argument("--threads", type=int, default=4, help="cpu only")
    ap.add_argument("--decode-batch", type=int, default=50)
    args = ap.parse_args(argv)

    dev = args.device
    if dev == "auto":
        dev = "cuda" if torch.cuda.is_available() else "cpu"
    device = torch.device(dev)
    if device.type == "cpu":
        torch.set_num_threads(args.threads)

    val = torch.load(args.data)
    if "notes" not in val:
        raise SystemExit(f"ABORT: {args.data} has no per-piece records; re-run "
                         f"preprocess.py with --eval (metrics need the notes and maps).")
    model, cfg, epoch = load_checkpoint(args.ckpt, val, device)
    mode = pack_mode(val)
    heads = bool(cfg.get("heads"))
    max_decode = val.get("max_tgt") or DEFAULT_MAX_DECODE[mode]
    n = len(val["feats"]) if args.limit is None else min(args.limit, len(val["feats"]))
    print(f"ckpt {args.ckpt} (epoch {epoch}) mode={mode} heads={heads} "
          f"params={sum(p.numel() for p in model.parameters())/1e6:.2f}M "
          f"device={device.type} pieces={n} max_decode={max_decode}", flush=True)

    med = run_eval(model, val, mode=mode, n_feat=cfg["n_features"], max_decode=max_decode,
                   heads=heads, device=device, n_pieces=args.limit,
                   decode_batch=args.decode_batch)
    med["_meta"] = {"ckpt": str(args.ckpt), "data": str(args.data), "epoch": epoch,
                    "mode": mode, "heads": heads, "n_pieces": n, "device": device.type,
                    "evaluator": "eval_ckpt.py"}
    with open(args.out, "w") as f:
        json.dump(med, f, indent=2)
    for k, v in med.items():
        if k != "_meta":
            print(f"  {k:<24} {v}")
    print(f"wrote {args.out}")
    return med


if __name__ == "__main__":
    main(sys.argv[1:])
