# ml/ — end-to-end MPM-generation experiments

Prototype for the plan in `../mpm-ml-research.md`: train a transformer to reconstruct
MPM from a score-aligned MIDI performance, using purely synthetic training data
(sample canonical MPM → render with the local meico fork → training pair).

- `java/SampleAndRender.java` — synthetic data generator (compiles against `../../meico`)
- `python/tempo_math.py` — exact port of meico's tempo rendering math (validated 0.0 ms diff)
- `python/dsl.py` — compact tempo-DSL tokenizer (lossless MPM round-trip)
- `python/dataset.py`, `model.py`, `train.py`, `evaluate.py` — training + eval
- `LOG.md` — iteration journal (read this first)
- `data/`, `runs/` — gitignored artifacts

Reproduce v0:

```sh
cd ml/java
javac -cp "$MEICO/out/production/meico:$MEICO/externals/*" -d out SampleAndRender.java
java  -cp "out:$MEICO/out/production/meico:$MEICO/externals/*" SampleAndRender ../data/train.jsonl 30000 1
java  -cp "out:$MEICO/out/production/meico:$MEICO/externals/*" SampleAndRender ../data/val.jsonl 1000 900001
cd ../python && python3 validate_data.py ../data/train.jsonl && python3 train.py 15 v0
```
