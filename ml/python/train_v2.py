"""Train the fenby v1.0 hybrid (`model_v2.py`) from a JSON run config.

Usage: python3 train_v2.py [epochs] [run_name] [mode] --config configs/base.json [flags]

Same CLI contract as `train.py` -- three positionals (epochs, run name, mode) with every
flag stripped before they are read, so order does not matter -- plus `--config`, which is
**required**: in a config-driven system the config file *is* the run's identity, and a
defaulted architecture is a run that cannot be reproduced from its own record.

Flags:
  --config PATH            JSON run config (required; stored verbatim in the checkpoint)
  --device cpu|cuda|auto   --threads N
  --head-weight W          overrides the config's train.head_weight
  --data DIR               directory holding train<SUFFIX>.pt / val<SUFFIX>.pt (../data)
  --limit N                use only the first N pieces of each split
  --batch N                overrides the config's train.batch (a CPU smoke of the `large`
                           config cannot hold the cluster's batch; the effective value is
                           recorded in the checkpoint, so an override is never silent)
  --max-steps N            stop after N optimiser steps; implies no checkpoint, no eval
                           (a smoke run must not overwrite a real run's checkpoint)

Three things differ from `train.py`, all deliberate:

* **It is a module with a `main()`.** `train.py`'s body *is* the run, so `import train`
  starts one -- which happened twice and rewrote a finished run's `final_val.json` (LOG.md).
  Here the import is inert and the tests can call the pieces.
* **The config guard is strict.** `train.py` tolerates keys a pre-config checkpoint lacks;
  every v2 checkpoint carries the full resolved config, so any difference on resume is a
  real difference and aborts with a printed diff.
* **`heads: true` in the config is a gate, not a preference.** `train.py` derives the heads
  arm from the pack (`bool(train.get("note_labels"))`), so a run against a stale pack trains
  the decoder alone and still logs as a v4 run -- the exact failure `CLUSTER_QUEUE.md` gates
  on by eye. A config that asks for heads and meets a pack without labels aborts.

The evaluation loop is imported from `eval_ckpt.py` (never copied): epoch-end metrics and
offline re-scoring must be the same code, or a re-evaluation proves nothing about the run.
"""

import json
import math
import random
import resource
import sys
import time
from pathlib import Path

import torch
import torch.nn as nn

from dsl import PAD
from eval_ckpt import run_eval as _run_eval
from model_v2 import (HEAD_MODES, PEDAL_FEATURE_INDEX, build_model, describe,
                      head_losses, load_run_config, resolve_model_cfg)

#: `mode` -> packed-file suffix, and -> the grammar `eval_ckpt.run_eval` scores against
#: (v3.1 evaluates as v3 and v4.1 as v4: they differ in their features, not in their DSL).
SUFFIX = {"v1": "", "v2": "_v2", "v3": "_v3", "v31": "_v31", "v4": "_v4", "v41": "_v41"}
EVAL_MODE = {"v1": "v1", "v2": "v2", "v3": "v3", "v31": "v3", "v4": "v4", "v41": "v4"}
DEFAULT_MAX_DECODE = {"v1": 224, "v2": 320, "v3": 448, "v31": 448, "v4": 512, "v41": 512}
DEFAULT_TRAIN = {"epochs": 10, "batch": 48, "lr": 3e-4, "warmup": 300,
                 "weight_decay": 0.01, "head_weight": 1.0, "clip": 1.0,
                 "eval_pieces": 100, "eval_every": 2, "decode_batch": 50,
                 "final_eval_pieces": 500}


def peak_rss_gb():
    """Peak resident set of this process. ``ru_maxrss`` is bytes on Darwin, KiB on Linux."""
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / 1024 ** 3 if sys.platform == "darwin" else r / 1024 ** 2


def take_flag(argv, name, cast=str, default=None):
    if name not in argv:
        return default
    i = argv.index(name)
    if i + 1 >= len(argv):
        raise SystemExit(f"ABORT: {name} needs a value")
    val = argv[i + 1]
    del argv[i:i + 2]
    return cast(val)


def parse_args(argv):
    argv = list(argv)
    args = {
        "config": take_flag(argv, "--config"),
        "device": take_flag(argv, "--device", default="cpu"),
        "threads": take_flag(argv, "--threads", int, 4),
        "head_weight": take_flag(argv, "--head-weight", float),
        "data": take_flag(argv, "--data", default="../data"),
        "limit": take_flag(argv, "--limit", int),
        "batch": take_flag(argv, "--batch", int),
        "max_steps": take_flag(argv, "--max-steps", int),
    }
    if args["device"] not in ("cpu", "cuda", "auto"):
        raise SystemExit(f"--device must be cpu|cuda|auto, got {args['device']}")
    if not args["config"]:
        raise SystemExit("ABORT: --config is required (e.g. --config configs/base.json)")
    args["epochs"] = int(argv[0]) if len(argv) > 0 else None
    args["run"] = argv[1] if len(argv) > 1 else None
    args["mode"] = argv[2] if len(argv) > 2 else None
    if len(argv) > 3:
        raise SystemExit(f"ABORT: unexpected positional argument(s) {argv[3:]}")
    return args


def resolve_heads(run_cfg, mode, pack):
    """``(heads_on, why)``. ``model.heads`` is ``true`` | ``false`` | ``"auto"``."""
    want = (run_cfg.get("model") or {}).get("heads", "auto")
    available = mode in HEAD_MODES and bool(pack.get("note_labels"))
    if want is True:
        if not available:
            raise SystemExit(
                f"ABORT: the config asks for per-note heads but the {mode} pack carries no "
                f"`note_labels`. That combination trains the decoder alone while logging as "
                f"a heads run -- re-preprocess the pack (preprocess.py --{mode}) or set "
                f"model.heads to false.")
        return True, "config"
    if want is False:
        return False, "config"
    if want != "auto":
        raise SystemExit(f"ABORT: model.heads must be true|false|\"auto\", got {want!r}")
    return available, "auto (pack carries note_labels)" if available else "auto (no labels)"


def check_pedal_leak(run_cfg, mode, cfg, heads):
    """f14 (`pedal_state`) is a head TARGET; leaving it in the input makes the pedal head
    copy its own answer (LOG.md 2026-08-10). Excluded by default; the leak is opt-in."""
    if not (heads and mode in HEAD_MODES):
        return "n/a"
    if PEDAL_FEATURE_INDEX in cfg["exclude_features"]:
        return "EXCLUDED (leak fix)"
    if run_cfg.get("allow_pedal_leak"):
        return "INPUT (leak deliberately allowed by the config)"
    raise SystemExit(
        f"ABORT: the pedal head is on and feature {PEDAL_FEATURE_INDEX} (pedal_state) is "
        f"still an input. The head would be scored largely on copying its own input -- the "
        f"v4 pedal MAEs (0.3cc / 1.17cc) are exactly this artefact. Add "
        f"{PEDAL_FEATURE_INDEX} to model.exclude_features, or set top-level "
        f"\"allow_pedal_leak\": true if the leak IS the experiment.")


def make_batch(pack, idxs, n_feat, heads):
    """``(x, x_pad_mask, y, note_labels|None)`` -- identical packing to `train.py`.

    Label rows are ``[artic_present, relative_duration, velocity_change, pedal_state]``;
    padded positions are masked by ``~x_pad_mask``, the same mask the encoder uses, so a
    padded note can never contribute to a head loss.
    """
    fs = [pack["feats"][i] for i in idxs]
    ts = [pack["tgts"][i].long() for i in idxs]
    max_n = max(f.shape[0] for f in fs)
    max_t = max(t.shape[0] for t in ts)
    b = len(fs)
    x = torch.zeros(b, max_n, n_feat)
    xm = torch.ones(b, max_n, dtype=torch.bool)
    y = torch.full((b, max_t), PAD, dtype=torch.long)
    for i, (f, t) in enumerate(zip(fs, ts)):
        x[i, : f.shape[0]] = f
        xm[i, : f.shape[0]] = False
        y[i, : t.shape[0]] = t
    if not heads:
        return x, xm, y, None
    lab = torch.zeros(b, max_n, 4)
    for i, idx in enumerate(idxs):
        li = pack["note_labels"][idx]
        lab[i, : li.shape[0]] = li
    return x, xm, y, lab


def config_diff(prev, now):
    keys = sorted(set(prev) | set(now))
    return {k: (prev.get(k, "<absent>"), now.get(k, "<absent>"))
            for k in keys if prev.get(k, "<absent>") != now.get(k, "<absent>")}


def main(argv):
    args = parse_args(argv)
    run_cfg = load_run_config(args["config"])
    cfg_mode = run_cfg.get("mode")
    mode = args["mode"] or cfg_mode
    if mode is None:
        raise SystemExit("ABORT: no mode -- give it positionally or as \"mode\" in the config")
    if cfg_mode and args["mode"] and cfg_mode != args["mode"]:
        raise SystemExit(f"ABORT: config says mode={cfg_mode!r} but the command line says "
                         f"{args['mode']!r}. One of them is wrong; refusing to pick.")
    if mode not in SUFFIX:
        raise SystemExit(f"ABORT: unknown mode {mode!r}; known: {sorted(SUFFIX)}")

    tcfg = dict(DEFAULT_TRAIN)
    tcfg.update({k: v for k, v in (run_cfg.get("train") or {}).items()
                 if not str(k).startswith("_")})
    # CLI overrides are folded into the effective train config BEFORE anything reads it, so
    # what the checkpoint records is what the run actually used, not what the file asked for
    if args["head_weight"] is not None:
        tcfg["head_weight"] = args["head_weight"]
    if args["batch"] is not None:
        tcfg["batch"] = args["batch"]
    if args["epochs"] is not None:
        tcfg["epochs"] = args["epochs"]
    epochs = int(tcfg["epochs"])
    run = args["run"] or run_cfg.get("name") or "v2"
    head_w = float(tcfg["head_weight"])
    max_steps = args["max_steps"]
    log_every = 1 if max_steps else 100

    dev = args["device"]
    if dev == "auto":
        dev = "cuda" if torch.cuda.is_available() else "cpu"
    device = torch.device(dev)
    if device.type == "cpu":
        torch.set_num_threads(args["threads"])
    else:
        # TF32 on cuda only: order-of-magnitude matmul speedup on H100/A100, never on the
        # cpu reference path, which keeps exact fp32 semantics
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

    run_dir = Path("../runs") / run
    run_dir.mkdir(parents=True, exist_ok=True)
    log_f = open(run_dir / "log.txt", "a")

    def log(msg):
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        print(line, flush=True)
        log_f.write(line + "\n")
        log_f.flush()

    sfx = SUFFIX[mode]
    train = torch.load(f"{args['data']}/train{sfx}.pt")
    val = torch.load(f"{args['data']}/val{sfx}.pt")
    if args["limit"]:
        for split in (train, val):
            for k, v in split.items():
                if isinstance(v, list):
                    split[k] = v[: args["limit"]]
    n_train = len(train["feats"])

    heads, heads_why = resolve_heads(run_cfg, mode, train)
    model_cfg = resolve_model_cfg(run_cfg, mode, heads=heads)
    pedal = check_pedal_leak(run_cfg, mode, model_cfg, heads)
    n_feat = model_cfg["n_features"]
    got_feat = int(train["feats"][0].shape[1])
    if got_feat != n_feat:
        raise SystemExit(f"ABORT: mode {mode} is {n_feat} features but "
                         f"{args['data']}/train{sfx}.pt carries {got_feat}")
    max_decode = train.get("max_tgt") or DEFAULT_MAX_DECODE[mode]

    # length-bucketed batches: sort by note count, batch contiguously, shuffle batch order
    batch = int(tcfg["batch"])
    order = sorted(range(n_train), key=lambda i: train["feats"][i].shape[0])
    batches = [order[i: i + batch] for i in range(0, n_train, batch)]

    model = build_model(model_cfg).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=float(tcfg["lr"]),
                            weight_decay=float(tcfg["weight_decay"]))
    crit = nn.CrossEntropyLoss(ignore_index=PAD)
    total_steps = epochs * len(batches)
    step = 0
    start_epoch = 0

    ck_path = run_dir / "ckpt.pt"
    if ck_path.exists():
        prev = torch.load(ck_path, map_location="cpu", weights_only=False)
        prev_cfg = dict(prev.get("config") or {})
        if prev.get("arch") != "model_v2":
            raise SystemExit(
                f"ABORT: {ck_path} was written by {prev.get('arch', 'model.py')}, not "
                f"model_v2. Use a new run name.")
        # Strict, unlike train.py's tolerant rule: every v2 checkpoint carries the full
        # resolved config, so a missing or differing key is a real difference, and resuming
        # across one silently reports a continuation of a run that never happened.
        diff = config_diff(prev_cfg, model_cfg)
        if diff:
            raise SystemExit(
                f"ABORT: {ck_path} exists but its config differs: "
                + "; ".join(f"{k}: ckpt={a!r} now={b!r}" for k, (a, b) in diff.items())
                + ". Use a new run name or delete the checkpoint explicitly.")
        model.load_state_dict(prev["model"], strict=True)
        if "opt" in prev:
            opt.load_state_dict(prev["opt"])
        start_epoch = prev["epoch"] + 1
        step = start_epoch * len(batches)
        log(f"resuming {run} from epoch {start_epoch}")

    lr, warmup, clip = float(tcfg["lr"]), int(tcfg["warmup"]), float(tcfg["clip"])

    def lr_at(s):
        if s < warmup:
            return lr * s / warmup
        return lr * 0.5 * (1 + math.cos(math.pi * min(1.0, (s - warmup) / total_steps)))

    def run_eval(n_pieces):
        return _run_eval(model, val, mode=EVAL_MODE[mode], n_feat=n_feat,
                         max_decode=max_decode, heads=heads, device=device,
                         n_pieces=n_pieces, decode_batch=int(tcfg["decode_batch"]))

    log(f"config={args['config']} name={run_cfg.get('name')} arch=model_v2 mode={mode} "
        f"| {describe(model_cfg, model)}")
    log(f"device={device.type} train={n_train} val={len(val['feats'])} epochs={epochs} "
        f"batch={batch} batches/epoch={len(batches)} lr={lr} warmup={warmup} "
        f"max_decode={max_decode} "
        f"heads={'on w=' + str(head_w) + ' [' + heads_why + ']' if heads else 'OFF [' + heads_why + ']'} "
        f"f14_pedal={pedal}")

    stop = False
    for epoch in range(start_epoch, epochs):
        model.train()
        random.seed(epoch)
        random.shuffle(batches)
        t0 = time.time()
        tot_loss = tot_tok = 0
        comp_sum = [0.0] * 4
        comp_n = 0
        for bi, idxs in enumerate(batches):
            step += 1
            for g in opt.param_groups:
                g["lr"] = lr_at(step)
            x, xm, y, lab = make_batch(train, idxs, n_feat, heads)
            x, xm, y = x.to(device), xm.to(device), y.to(device)
            if heads:
                logits, hd = model(x, xm, y[:, :-1], return_heads=True)
            else:
                logits = model(x, xm, y[:, :-1])
            ce = crit(logits.reshape(-1, logits.shape[-1]), y[:, 1:].reshape(-1))
            loss = ce
            if heads:
                comps = head_losses(hd, lab.to(device), ~xm)
                loss = ce + head_w * sum(comps)
                comp_sum = [s + float(c.detach()) for s, c in zip(comp_sum, comps)]
                comp_n += 1
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), clip)
            opt.step()
            ntok = int((y[:, 1:] != PAD).sum())
            # the logged `loss` stays the token CE alone, as in v1-v4, so the number means
            # the same thing across runs; the head terms are reported beside it, not folded in
            tot_loss += float(ce.detach()) * ntok
            tot_tok += ntok
            if step % log_every == 0:
                extra = ""
                if comp_n:
                    b, r, v, p = (s / comp_n for s in comp_sum)
                    extra = (f" | head bce {b:.4f} relDur {r:.4f} velCh {v:.4f} "
                             f"pedal {p:.4f} (w {head_w})")
                    comp_sum, comp_n = [0.0] * 4, 0
                log(f"epoch {epoch} step {step}/{total_steps} loss {tot_loss/tot_tok:.4f} "
                    f"({(time.time()-t0)/(bi+1):.2f}s/step) rss {peak_rss_gb():.2f}GB{extra}")
                tot_loss = tot_tok = 0
            if max_steps and step >= max_steps:
                stop = True
                break
        if stop:
            # smoke run: no checkpoint, no eval -- see --max-steps at the top
            log(f"SMOKE_COMPLETE after {step} steps ({time.time()-t0:.0f}s) "
                f"peak_rss={peak_rss_gb():.2f}GB")
            break
        msg = f"EPOCH {epoch} DONE ({time.time()-t0:.0f}s) peak_rss={peak_rss_gb():.2f}GB"
        ev_every = int(tcfg["eval_every"])
        if not max_steps and (epoch % ev_every == ev_every - 1 or epoch == epochs - 1):
            med = run_eval(int(tcfg["eval_pieces"]))
            msg += format_metrics(med, EVAL_MODE[mode], heads)
        log(msg)
        # a --max-steps budget that crosses an epoch boundary must still not checkpoint
        if not max_steps:
            torch.save({"model": model.state_dict(), "opt": opt.state_dict(),
                        "epoch": epoch, "config": model_cfg, "arch": "model_v2",
                        "mode": mode, "head_weight": head_w, "run_config": run_cfg,
                        "train_config": tcfg},
                       ck_path)

    if not max_steps:
        with open(run_dir / "final_val.json", "w") as f:
            json.dump(run_eval(min(int(tcfg["final_eval_pieces"]), len(val["feats"]))),
                      f, indent=2)
        log("TRAINING_COMPLETE")
    log_f.close()


def format_metrics(med, mode, heads):
    """The epoch-end metric line, in `train.py`'s wording so the two runs' logs compare."""
    if mode == "v4":
        msg = (f" val: exact={med['exact']:.2f} "
               f"render_rmse={med['render_rmse']:.1f}ms (base {med['base_render_rmse']:.1f}ms) "
               f"off_rmse={med['off_rmse']:.1f}ms (base {med['base_off_rmse']:.1f}ms) "
               f"vel_rmse={med['vel_rmse']:.2f} (base {med['base_vel_rmse']:.2f}) "
               f"cc_rmse={med['cc_rmse']:.2f} (base {med['base_cc_rmse']:.2f}) "
               f"cc64={med['cc64_agree']:.2f} (base {med['base_cc64_agree']:.2f}) "
               f"asyn_err={med['asyn_offset_err']:.1f}ms (base {med['base_asyn_offset_err']:.1f}ms) "
               f"boundary_f1={med['boundary_f1']:.2f} rubato_f1={med['rubato_f1']:.2f} "
               f"mdl_sub={med['mdl_ratio_subset']:.2f} mdl_full={med['mdl_ratio_full']:.2f} "
               f"nonfinite={med['n_nonfinite']:.1f} n_pred={med['n_pred']} n_gt={med['n_gt']}")
        if heads:
            msg += (f" | heads: artic_f1={med['artic_note_f1']:.2f} "
                    f"(P {med['artic_note_prec']:.2f} R {med['artic_note_rec']:.2f}) "
                    f"relDur_mae={med['artic_reldur_mae']:.3f} "
                    f"velCh_mae={med['artic_vel_mae']:.2f} "
                    f"pedal_mae={med['pedal_state_mae']:.1f}cc "
                    f"n_artic={med['n_artic_pred']:.0f}/{med['n_artic_gt']:.0f}")
        return msg
    if mode == "v3":
        return (f" val: exact={med['exact']:.2f} "
                f"render_rmse={med['render_rmse']:.1f}ms (base {med['base_render_rmse']:.1f}ms) "
                f"vel_rmse={med['vel_rmse']:.2f} (base {med['base_vel_rmse']:.2f}) "
                f"boundary_f1={med['boundary_f1']:.2f} rubato_f1={med['rubato_f1']:.2f} "
                f"artic_f1={med['artic_f1']:.2f} mdl_ratio={med['mdl_ratio']:.2f} "
                f"nonfinite={med['n_nonfinite']:.1f} n_pred={med['n_pred']} n_gt={med['n_gt']}")
    msg = (f" val: exact={med['exact']:.2f} curve_rmse={med['curve_rmse']:.4f} "
           f"(base {med['base_curve_rmse']:.4f}) render_rmse={med['render_rmse']:.1f}ms "
           f"(base {med['base_render_rmse']:.1f}ms) boundary_f1={med['boundary_f1']:.2f} "
           f"n_pred={med['n_pred']} n_gt={med['n_gt']}")
    if mode == "v2":
        msg += (f" | vel_rmse={med['vel_rmse']:.2f} (base {med['base_vel_rmse']:.2f}) "
                f"dyn_f1={med['dyn_boundary_f1']:.2f}")
    return msg


if __name__ == "__main__":
    main(sys.argv[1:])
