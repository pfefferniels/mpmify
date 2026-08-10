"""Score a `model_v2` checkpoint with `eval_ckpt.py`'s evaluator — an adapter, not a copy.

    python3 eval_ckpt_v2.py --ckpt ../runs/v2-base/ckpt.pt --data ../data/val_v41.pt \
                            --out ../runs/v2-base/final_val.json --limit 50

`eval_ckpt.load_checkpoint` builds a `model.TempoTransformer` from the checkpoint's config;
a `model_v2` config carries keys that class does not take (`pos`, `activation`,
`exclude_features`, `max_len`, and `dropout`, which it passes itself), so it raises rather
than mis-building — loud, which is correct, but it needs a counterpart that knows the new
class. This file is exactly that counterpart and nothing more: the model is rebuilt from the
checkpoint's own `config`, the same two aborts fire (vocabulary size, feature width) against
the same constants, and the scoring loop is `eval_ckpt.run_eval` **imported**. A second
decode-and-score implementation is precisely how an offline evaluator drifts from the
training one, which is the class of bug `eval_ckpt.py` was written to repair.

One consequence of the f14 fix is worth stating here, because it looks like a mismatch and
is not: a model with `exclude_features=[14]` still declares `n_features = 16`. The declared
width is the width of the *pack* (what the model must be fed), and the exclusion happens
inside the input projection — so the feature-width guard keeps its meaning and a leaking and
a non-leaking checkpoint are scored on the same data by the same code.
"""

import argparse
import json
import sys

import torch

from eval_ckpt import DEFAULT_MAX_DECODE, VOCAB_SIZES, pack_mode, run_eval
from model_v2 import build_model, describe, param_count


def load_checkpoint(ckpt_path, val, device):
    """``(model, config, epoch)`` rebuilt from the checkpoint's own config, checked against
    ``val`` with `eval_ckpt`'s constants (imported, so there is one table, not two)."""
    ck = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    if ck.get("arch") != "model_v2":
        raise SystemExit(
            f"ABORT: {ckpt_path} declares arch={ck.get('arch', '<none>')!r}. A pre-v2 "
            f"checkpoint is scored with eval_ckpt.py, not this adapter.")
    cfg = dict(ck.get("config") or {})
    if not cfg:
        raise SystemExit(f"ABORT: {ckpt_path} carries no `config`; refusing to guess the "
                         f"architecture.")
    mode = pack_mode(val)
    want_vocab = VOCAB_SIZES[mode]
    if cfg.get("vocab_size") != want_vocab:
        raise SystemExit(
            f"ABORT: checkpoint vocab_size {cfg.get('vocab_size')} but the pack is {mode} "
            f"(vocab {want_vocab}). Point --data at the matching val pack.")
    got_feat = int(val["feats"][0].shape[1])
    if cfg.get("n_features") != got_feat:
        raise SystemExit(
            f"ABORT: checkpoint n_features {cfg.get('n_features')} but the pack carries "
            f"{got_feat} features per note (v4 packs are 15 wide, v4.1 packs 16). Note that "
            f"`exclude_features` does NOT change this number -- it is the pack's width.")
    model = build_model(cfg).to(device)
    model.load_state_dict(ck["model"], strict=True)
    model.eval()
    return model, cfg, ck.get("epoch")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ckpt", required=True, help="path to a model_v2 ckpt.pt")
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
    print(f"ckpt {args.ckpt} (epoch {epoch}) arch=model_v2 mode={mode} "
          f"| {describe(cfg, model)} device={device.type} pieces={n} "
          f"max_decode={max_decode}", flush=True)

    med = run_eval(model, val, mode=mode, n_feat=cfg["n_features"], max_decode=max_decode,
                   heads=heads, device=device, n_pieces=args.limit,
                   decode_batch=args.decode_batch)
    med["_meta"] = {"ckpt": str(args.ckpt), "data": str(args.data), "epoch": epoch,
                    "mode": mode, "heads": heads, "n_pieces": n, "device": device.type,
                    "arch": "model_v2", "params": param_count(model),
                    "exclude_features": list(cfg.get("exclude_features") or []),
                    "evaluator": "eval_ckpt.run_eval via eval_ckpt_v2.py"}
    with open(args.out, "w") as f:
        json.dump(med, f, indent=2)
    for k, v in med.items():
        if k != "_meta":
            print(f"  {k:<24} {v}")
    print(f"wrote {args.out}")
    return med


if __name__ == "__main__":
    main(sys.argv[1:])
