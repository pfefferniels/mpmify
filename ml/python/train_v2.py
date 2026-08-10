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
                           recorded in the checkpoint AND guarded on resume, so an override
                           is never silent)
  --seed N                 overrides the config's train.seed (default 0)
  --max-steps N            stop after N optimiser steps; implies no checkpoint, no eval
                           (a smoke run must not overwrite a real run's checkpoint)

Four things differ from `train.py`, all deliberate:

* **It is a module with a `main()`.** `train.py`'s body *is* the run, so `import train`
  starts one -- which happened twice and rewrote a finished run's `final_val.json` (LOG.md).
  Here the import is inert and the tests can call the pieces.
* **The config guard is strict, and it covers the schedule.** `train.py` tolerates keys a
  pre-config checkpoint lacks; every v2 checkpoint carries the full resolved model config
  *and* the effective train config, and both are diffed on resume. Architecture-only
  guarding is not enough: ``--batch`` changes ``len(batches)``, hence ``total_steps`` and
  the ``step`` a resume restarts from, so resuming a run at a different batch size silently
  relocates the cosine LR schedule -- a changed experiment reported under the old name.
* **`heads: true` in the config is a gate, not a preference.** `train.py` derives the heads
  arm from the pack (`bool(train.get("note_labels"))`), so a run against a stale pack trains
  the decoder alone and still logs as a v4 run -- the exact failure `CLUSTER_QUEUE.md` gates
  on by eye. A config that asks for heads and meets a pack without labels aborts.
* **The run is seeded** (``train.seed``, default 0), so it is reproducible from its record
  and not only describable by it. `train.py` is unseeded; three runs of one v2 smoke command
  gave three different step-1 losses before this.

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
from model_v2 import (HEAD_MODES, MODE_MAX_DECODE, MODEL_DEFAULTS, PEDAL_FEATURE_INDEX,
                      build_model, defaulted_keys, describe, head_losses, load_run_config,
                      resolve_model_cfg, seed_everything, verify_pedal_index)

#: `mode` -> packed-file suffix, and -> the grammar `eval_ckpt.run_eval` scores against
#: (v3.1 evaluates as v3 and v4.1 as v4: they differ in their features, not in their DSL).
SUFFIX = {"v1": "", "v2": "_v2", "v3": "_v3", "v31": "_v31", "v4": "_v4", "v41": "_v41"}
EVAL_MODE = {"v1": "v1", "v2": "v2", "v3": "v3", "v31": "v3", "v4": "v4", "v41": "v4"}
#: one table, defined in model_v2 and shared with eval_ckpt_v2 -- see MODE_MAX_DECODE there
DEFAULT_MAX_DECODE = MODE_MAX_DECODE
DEFAULT_TRAIN = {"epochs": 10, "batch": 48, "lr": 3e-4, "warmup": 300,
                 "weight_decay": 0.01, "head_weight": 1.0, "clip": 1.0, "seed": 0,
                 "eval_pieces": 100, "eval_every": 2, "decode_batch": 50,
                 "final_eval_pieces": 500}
#: Train keys a resume may NOT change: each one moves the optimisation itself. `batch` is in
#: the list because it sets `len(batches)`, and therefore `total_steps` and the step a resume
#: restarts at -- the cosine schedule would land somewhere the original run never visited.
SCHEDULE_KEYS = ("epochs", "batch", "lr", "warmup", "weight_decay", "head_weight", "clip",
                 "seed")
#: Train keys a resume MAY change (they only affect how much is measured, never the weights).
#: Changing one is logged, not refused.
EVAL_KEYS = ("eval_pieces", "eval_every", "decode_batch", "final_eval_pieces")


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
        "seed": take_flag(argv, "--seed", int),
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
    copy its own answer (LOG.md 2026-08-10). Excluded by default; the leak is opt-in.

    The index itself is re-proved against `dataset.py` on every call rather than trusted from
    a constant, so a re-preprocessed pack that moved the column aborts the run instead of
    training a leaking model under a log line that says EXCLUDED.
    """
    if not (heads and mode in HEAD_MODES):
        return "n/a"
    verify_pedal_index(mode)
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


def effective_train_cfg(run_cfg, overrides=None):
    """``DEFAULT_TRAIN`` < the config's ``train`` block < CLI overrides.

    Resolved in one place and BEFORE anything reads it, so the checkpoint records what the
    run used rather than what the file asked for -- and so the resume guard compares the two
    effective schedules, not a file against a run.
    """
    tcfg = dict(DEFAULT_TRAIN)
    tcfg.update({k: v for k, v in (run_cfg.get("train") or {}).items()
                 if not str(k).startswith("_")})
    for k in ("head_weight", "batch", "epochs", "seed"):
        v = (overrides or {}).get(k)
        if v is not None:
            tcfg[k] = v
    return tcfg


def epoch_order(batches, seed, epoch):
    """The batch order for one epoch: a pure function of ``(seed, epoch)``.

    `train.py` seeds the global RNG with the epoch number and shuffles the list **in place**,
    so its epoch-k order depends on every shuffle before it and a resumed run trains on an
    order the uninterrupted run never used. Shuffling a copy with a local generator makes the
    order replayable, which is what makes a resumed run the same run.
    """
    out = list(batches)
    random.Random(int(seed) * 100003 + int(epoch)).shuffle(out)
    return out


def config_diff(prev, now, keys=None):
    """``{key: (was, now)}`` over the union of both dicts, or over ``keys`` if given.

    An absent key counts as a difference (``"<absent>"``): a checkpoint that never recorded
    a setting cannot testify that the setting was the same.
    """
    ks = sorted(set(prev) | set(now)) if keys is None else list(keys)
    return {k: (prev.get(k, "<absent>"), now.get(k, "<absent>"))
            for k in ks if prev.get(k, "<absent>") != now.get(k, "<absent>")}


def fmt_diff(diff):
    return "; ".join(f"{k}: ckpt={a!r} now={b!r}" for k, (a, b) in sorted(diff.items()))


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

    # CLI overrides are folded into the effective train config BEFORE anything reads it, so
    # what the checkpoint records is what the run actually used, not what the file asked for
    tcfg = effective_train_cfg(run_cfg, args)
    epochs = int(tcfg["epochs"])
    run = args["run"] or run_cfg.get("name") or "v2"
    head_w = float(tcfg["head_weight"])
    seed = int(tcfg["seed"])
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

    # before build_model: weight init is the first draw from the global RNG, so an unseeded
    # run differs from its own record in the one place a record cannot capture
    seed_everything(seed)
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
                f"ABORT: {ck_path} exists but its model config differs: " + fmt_diff(diff)
                + ". Use a new run name or delete the checkpoint explicitly.")
        # ... and the same rule for the schedule. Architecture-only guarding let a resume
        # change batch/lr/warmup/epochs/seed without a word, and `batch` in particular moves
        # `len(batches)` -> `total_steps` and `step = start_epoch * len(batches)`, i.e. the
        # cosine schedule restarts at a point the original run never occupied.
        prev_tcfg = dict(prev.get("train_config") or {})
        if not prev_tcfg:
            raise SystemExit(
                f"ABORT: {ck_path} carries no `train_config`. It was written by a model_v2 "
                f"build that guarded the architecture only, so this resume cannot prove it "
                f"is continuing the same schedule. Use a new run name.")
        sdiff = config_diff(prev_tcfg, tcfg, SCHEDULE_KEYS)
        if sdiff:
            raise SystemExit(
                f"ABORT: {ck_path} exists but its training schedule differs: "
                + fmt_diff(sdiff)
                + ". These keys change the optimisation itself (batch also moves the LR "
                  "schedule, via batches/epoch -> total_steps). Use a new run name.")
        ediff = config_diff(prev_tcfg, tcfg, EVAL_KEYS)
        model.load_state_dict(prev["model"], strict=True)
        if "opt" in prev:
            opt.load_state_dict(prev["opt"])
        start_epoch = prev["epoch"] + 1
        step = start_epoch * len(batches)
        log(f"resuming {run} from epoch {start_epoch} (step {step}/{total_steps}, "
            f"seed {seed}, batch {batch}: schedule verified against the checkpoint)")
        if ediff:
            log(f"NOTE: evaluation settings changed on resume (weights unaffected): "
                f"{fmt_diff(ediff)}")

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
        f"batch={batch} batches/epoch={len(batches)} lr={lr} warmup={warmup} seed={seed} "
        f"max_decode={max_decode} "
        f"heads={'on w=' + str(head_w) + ' [' + heads_why + ']' if heads else 'OFF [' + heads_why + ']'} "
        f"f14_pedal={pedal}")
    # A default is legitimate; a silent default is not. Both blocks report what they took.
    md = defaulted_keys(run_cfg.get("model"), MODEL_DEFAULTS)
    td = defaulted_keys({k: v for k, v in (run_cfg.get("train") or {}).items()
                         if not str(k).startswith("_")}, DEFAULT_TRAIN)
    log(f"defaults taken: model{md or '{}'} train{td or '{}'}"
        + (f" | cli overrides: "
           + ", ".join(f"{k}={args[k]}" for k in ("epochs", "batch", "seed", "head_weight")
                       if args[k] is not None)
           if any(args[k] is not None
                  for k in ("epochs", "batch", "seed", "head_weight")) else ""))
    if pedal != "n/a":
        log(f"pedal index: {verify_pedal_index(mode)}")

    stop = False
    for epoch in range(start_epoch, epochs):
        model.train()
        epoch_batches = epoch_order(batches, seed, epoch)
        t0 = time.time()
        tot_loss = tot_tok = 0
        comp_sum = [0.0] * 4
        comp_n = 0
        for bi, idxs in enumerate(epoch_batches):
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
                        "train_config": tcfg, "seed": seed,
                        # the decode budget this run's epoch-end evals actually used, so an
                        # offline re-score can reproduce them instead of re-deriving it from
                        # a table (eval_ckpt.py's says 320 for v4 and has no v41 entry)
                        "max_decode": int(max_decode)},
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
