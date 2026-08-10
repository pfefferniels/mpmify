#!/bin/zsh
# v4 autopilot: generate + preprocess alongside v3.1, then wait for v3.1 completion,
# honor the MLign gap window, then train.
set -e
V31_LOG="$1"   # log file of the running v3.1 training
ML="/Users/nielspfeffer/Projects/mpmify/ml"
GAP_SECONDS=5400   # promised MLign burst window after v3.1 completes

cd "$ML/node"
nice -n 15 node generate_v4.mjs ../data/train_v4.jsonl 20000 44001 --renderer java > /dev/null
nice -n 15 node generate_v4.mjs ../data/val_v4.jsonl    1000 944001 --renderer java > /dev/null
nice -n 15 node generate_v4.mjs ../data/test_v4.jsonl   1000 994001 --renderer java > /dev/null
echo "V4_DATA_GENERATED"

nice -n 15 node verify_v4.mjs invariants ../data/val_v4.jsonl | tail -1

cd "$ML/python"
nice -n 15 python3 preprocess.py ../data/train_v4.jsonl ../data/train_v4.pt --v4
nice -n 15 python3 preprocess.py ../data/val_v4.jsonl   ../data/val_v4.pt   --v4 --eval
echo "V4_PREPROCESSED"

until grep -q TRAINING_COMPLETE "$V31_LOG" 2>/dev/null; do sleep 60; done
echo "V31_COMPLETE_GAP_STARTS"
sleep "$GAP_SECONDS"
echo "GAP_OVER_STARTING_V4_TRAINING"

caffeinate -is python3 train.py 24 v4 v4
