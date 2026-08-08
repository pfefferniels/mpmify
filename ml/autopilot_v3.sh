#!/bin/zsh
# v3 autopilot: wait for the v2 extension run, then generate/validate/preprocess/train v3.
set -e
V2_LOG="$1"          # task output file of the running v2 training
MEICO="/Users/nielspfeffer/Projects/meico"
ML="/Users/nielspfeffer/Projects/mpmify/ml"
CP="out:$MEICO/out/production/meico:$MEICO/externals/*"

until grep -q TRAINING_COMPLETE "$V2_LOG" 2>/dev/null; do sleep 60; done
echo "V2_COMPLETE_STARTING_V3_PIPELINE"

cd "$ML/java"
nice -n 5 java -cp "$CP" SampleAndRender ../data/train_v3.jsonl 20000 31 tempo,dynamics,articulation,rubato > /dev/null
nice -n 5 java -cp "$CP" SampleAndRender ../data/val_v3.jsonl   1000 930001 tempo,dynamics,articulation,rubato > /dev/null
nice -n 5 java -cp "$CP" SampleAndRender ../data/test_v3.jsonl  1000 980001 tempo,dynamics,articulation,rubato > /dev/null
echo "V3_DATA_GENERATED"

cd "$ML/python"
# spot-validate 200 val pieces through the exact chain (bit-level gate)
python3 - <<'PYEOF'
import json
from perf_chain import PerfChain
bad = n = 0
for k, line in enumerate(open("../data/val_v3.jsonl")):
    if k >= 200: break
    rec = json.loads(line)
    chain = PerfChain(rec["tempo"], rec["dynamics"], rec["articulation"], rec["rubato"])
    for np_, note in zip(chain.render([(x[0], x[1]) for x in rec["notes"]]), rec["notes"]):
        n += 1
        if np_.ms_on != note[3] or np_.ms_off != note[4] or np_.velocity != note[5]:
            bad += 1
print(f"V3_SPOT_VALIDATION {bad}/{n} mismatches")
assert bad == 0
PYEOF

python3 preprocess.py ../data/train_v3.jsonl ../data/train_v3.pt --v3
python3 preprocess.py ../data/val_v3.jsonl ../data/val_v3.pt --v3 --eval
echo "V3_PREPROCESSED"

caffeinate -is python3 train.py 24 v3 v3
