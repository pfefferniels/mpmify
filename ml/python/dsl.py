"""Compact tempo-DSL tokenizer.

Target sequence per piece (linear grammar):
  BOS ( T <date_beats> B <bpm> ( C | R <to_bpm> M <mta> ) )* EOS
Numbers are emitted as digit/'.' tokens. Dates are integer beats (canonical form
guarantees beat-aligned boundaries). bpm has <=1 decimal, mta exactly 2 decimals.
"""

VOCAB = ["<pad>", "<bos>", "<eos>", "T", "B", "C", "R", "M",
         "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".",
         # v2 additions (appended so v1 token ids stay stable)
         "D", "V", "Q", "P", "-",
         # v3 additions (appended so v1/v2 token ids stay stable):
         # rubato 'U'<date>'F'<frameBeats>'I'<intensity>'X'<endDate>
         # articulation 'A'<date>'L'<relDur>'W'<velChange>
         "U", "F", "I", "X", "A", "L", "W"]
TOK2ID = {t: i for i, t in enumerate(VOCAB)}
PAD, BOS, EOS = 0, 1, 2
V1_VOCAB_SIZE = 19
V2_VOCAB_SIZE = 24  # frozen: runs/v2 ckpts were trained with exactly these 24 tokens


def _num_tokens(x):
    s = f"{x:g}"
    return list(s)


def encode_tempo_map(tempo_map, ppq=720):
    toks = ["<bos>"]
    for date, bpm, to, mta in tempo_map:
        toks.append("T")
        toks += _num_tokens(round(date / ppq))
        toks.append("B")
        toks += _num_tokens(bpm)
        if to is None:
            toks.append("C")
        else:
            toks.append("R")
            toks += _num_tokens(to)
            toks.append("M")
            toks += _num_tokens(mta)
    toks.append("<eos>")
    return [TOK2ID[t] for t in toks]


def encode_piece(tempo_map, dyn_map, ppq=720):
    """v2: tempo instructions then dynamics instructions, grouped by map.
    Dynamics grammar: D <date_beats> V <vol> ( C | R <to> Q <curv> P <prot> )"""
    toks = ["<bos>"]
    for date, bpm, to, mta in tempo_map:
        toks.append("T")
        toks += _num_tokens(round(date / ppq))
        toks.append("B")
        toks += _num_tokens(bpm)
        if to is None:
            toks.append("C")
        else:
            toks.append("R")
            toks += _num_tokens(to)
            toks.append("M")
            toks += _num_tokens(mta)
    for date, vol, to, curv, prot in dyn_map:
        toks.append("D")
        toks += _num_tokens(round(date / ppq))
        toks.append("V")
        toks += _num_tokens(vol)
        if to is None:
            toks.append("C")
        else:
            toks.append("R")
            toks += _num_tokens(to)
            toks.append("Q")
            toks += _num_tokens(curv)
            toks.append("P")
            toks += _num_tokens(prot)
    toks.append("<eos>")
    return [TOK2ID[t] for t in toks]


def decode_piece(ids, ppq=720):
    """Parse v2 token stream -> (tempo_map, dyn_map, n_errors). Tolerant."""
    toks = [VOCAB[i] for i in ids if 0 <= i < len(VOCAB) and i not in (PAD, BOS, EOS)]
    tempo_map, dyn_map, errors = [], [], 0
    i = 0

    def read_num(j):
        s = ""
        while j < len(toks) and toks[j] in "0123456789.-":
            s += toks[j]
            j += 1
        try:
            return float(s), j
        except ValueError:
            return None, j

    while i < len(toks):
        kind = toks[i]
        if kind not in ("T", "D"):
            i += 1
            errors += 1
            continue
        date, i2 = read_num(i + 1)
        expect = "B" if kind == "T" else "V"
        if date is None or i2 >= len(toks) or toks[i2] != expect:
            i = max(i2, i + 1)
            errors += 1
            continue
        main, i3 = read_num(i2 + 1)
        if main is None or i3 >= len(toks):
            i = i3
            errors += 1
            continue
        if toks[i3] == "C":
            (tempo_map if kind == "T" else dyn_map).append(
                [date * ppq, main, None, None] if kind == "T"
                else [date * ppq, main, None, None, None])
            i = i3 + 1
        elif toks[i3] == "R":
            to, i4 = read_num(i3 + 1)
            k2 = "M" if kind == "T" else "Q"
            if to is None or i4 >= len(toks) or toks[i4] != k2:
                i = i4
                errors += 1
                continue
            p1, i5 = read_num(i4 + 1)
            if p1 is None:
                i = i5
                errors += 1
                continue
            if kind == "T":
                tempo_map.append([date * ppq, main, to, p1])
                i = i5
            else:
                if i5 >= len(toks) or toks[i5] != "P":
                    errors += 1
                    i = i5
                    continue
                p2, i6 = read_num(i5 + 1)
                if p2 is None:
                    i = i6
                    errors += 1
                    continue
                dyn_map.append([date * ppq, main, to, p1, p2])
                i = i6
        else:
            i = i3
            errors += 1

    tempo_map = _sanitize_tempo(tempo_map, ppq)
    dyn_map = _sanitize_dyn(dyn_map, ppq)
    return tempo_map, dyn_map, errors


def _sanitize_tempo(tempo_map, ppq):
    tempo_map = [t for t in tempo_map if 0 <= t[0] <= 10_000 * ppq and 1 <= t[1] <= 1000]
    tempo_map.sort(key=lambda t: t[0])
    dedup = []
    for t in tempo_map:
        if dedup and dedup[-1][0] == t[0]:
            dedup[-1] = t
        else:
            dedup.append(t)
    tempo_map = dedup
    for t in tempo_map:
        if t[2] is not None:
            if not (1 <= t[2] <= 1000):
                t[2], t[3] = None, None
            elif t[3] is None or not (0.01 <= t[3] <= 0.99):
                t[3] = 0.5
    if tempo_map and tempo_map[-1][2] is not None:
        tempo_map[-1][2] = None
        tempo_map[-1][3] = None
    return tempo_map


def _sanitize_dyn(dyn_map, ppq):
    dyn_map = [d for d in dyn_map if 0 <= d[0] <= 10_000 * ppq and 0 <= d[1] <= 200]
    dyn_map.sort(key=lambda d: d[0])
    dedup = []
    for d in dyn_map:
        if dedup and dedup[-1][0] == d[0]:
            dedup[-1] = d
        else:
            dedup.append(d)
    dyn_map = dedup
    for d in dyn_map:
        if d[2] is not None:
            if not (0 <= d[2] <= 200):
                d[2] = d[3] = d[4] = None
            else:
                if d[3] is None or not (0 <= d[3] <= 1):
                    d[3] = 0.0
                if d[4] is None or not (-1 <= d[4] <= 1):
                    d[4] = 0.0
    if dyn_map and dyn_map[-1][2] is not None:
        dyn_map[-1][2] = None
        dyn_map[-1][3] = None
        dyn_map[-1][4] = None
    return dyn_map


def encode_piece_v3(tempo_map, dyn_map, artic, rubato, ppq=720):
    """v3: tempo, dynamics, rubato (paired span+terminator rows -> one production),
    articulation. Rubato spans must be canonical: opener (intensity != 1.0) directly
    followed by its neutral terminator (intensity == 1.0, lateStart 0, earlyEnd 1)."""
    ids = encode_piece(tempo_map, dyn_map, ppq)[:-1]  # strip <eos>
    toks = []
    i = 0
    rub = sorted(rubato or [], key=lambda r: r[0])
    while i < len(rub):
        row = rub[i]
        if row[2] == 1.0:  # stray terminator without opener: skip
            i += 1
            continue
        if i + 1 >= len(rub) or rub[i + 1][2] != 1.0:
            raise ValueError(f"unpaired rubato span at date {row[0]}")
        term = rub[i + 1]
        toks.append("U")
        toks += _num_tokens(row[0] / ppq)
        toks.append("F")
        toks += _num_tokens(row[1] / ppq)
        toks.append("I")
        toks += _num_tokens(row[2])
        toks.append("X")
        toks += _num_tokens(term[0] / ppq)
        i += 2
    for date, rel_dur, vel_change in sorted(artic or [], key=lambda a: a[0]):
        toks.append("A")
        toks += _num_tokens(date / ppq)  # NOT rounded: artic dates sit on beat fractions
        toks.append("L")
        toks += _num_tokens(rel_dur)
        toks.append("W")
        toks += _num_tokens(vel_change)
    return ids + [TOK2ID[t] for t in toks] + [TOK2ID["<eos>"]]


def decode_piece_v3(ids, ppq=720):
    """Parse v3 tokens -> (tempo, dyn, artic, rubato, errors). Tolerant + sanitized;
    rubato is re-expanded to paired 6-field rows [date, frame, I, 0, 1, 1] + terminator."""
    toks = [VOCAB[i] for i in ids if 0 <= i < len(VOCAB) and i not in (PAD, BOS, EOS)]
    tempo_map, dyn_map, artic, rub_raw = [], [], [], []
    errors = 0
    i = 0

    def read_num(j):
        s = ""
        while j < len(toks) and toks[j] in "0123456789.-":
            s += toks[j]
            j += 1
        try:
            return float(s), j
        except ValueError:
            return None, j

    def fields(j, spec):
        """Read alternating marker/number fields, e.g. spec='FIX' after 'U'<num>."""
        vals = []
        for marker in spec:
            if j >= len(toks) or toks[j] != marker:
                return None, j
            v, j = read_num(j + 1)
            if v is None:
                return None, j
            vals.append(v)
        return vals, j

    while i < len(toks):
        kind = toks[i]
        if kind == "T" or kind == "D":
            date, i2 = read_num(i + 1)
            expect = "B" if kind == "T" else "V"
            if date is None or i2 >= len(toks) or toks[i2] != expect:
                i = max(i2, i + 1)
                errors += 1
                continue
            main, i3 = read_num(i2 + 1)
            if main is None or i3 >= len(toks):
                i = i3
                errors += 1
                continue
            if toks[i3] == "C":
                (tempo_map if kind == "T" else dyn_map).append(
                    [date * ppq, main, None, None] if kind == "T"
                    else [date * ppq, main, None, None, None])
                i = i3 + 1
            elif toks[i3] == "R":
                spec = "RM" if kind == "T" else "RQP"
                vals, i4 = fields(i3, spec)
                if vals is None:
                    i = i4
                    errors += 1
                    continue
                if kind == "T":
                    tempo_map.append([date * ppq, main, vals[0], vals[1]])
                else:
                    dyn_map.append([date * ppq, main, vals[0], vals[1], vals[2]])
                i = i4
            else:
                i = i3
                errors += 1
        elif kind == "U":
            date, i2 = read_num(i + 1)
            vals, i3 = fields(i2, "FIX") if date is not None else (None, i2)
            if vals is None:
                i = max(i3, i + 1)
                errors += 1
                continue
            rub_raw.append([date * ppq, vals[0] * ppq, vals[1], vals[2] * ppq])
            i = i3
        elif kind == "A":
            date, i2 = read_num(i + 1)
            vals, i3 = fields(i2, "LW") if date is not None else (None, i2)
            if vals is None:
                i = max(i3, i + 1)
                errors += 1
                continue
            artic.append([date * ppq, vals[0], vals[1]])
            i = i3
        else:
            i += 1
            errors += 1

    tempo_map = _sanitize_tempo(tempo_map, ppq)
    dyn_map = _sanitize_dyn(dyn_map, ppq)
    artic = _sanitize_artic(artic, ppq)
    rubato = _sanitize_rubato(rub_raw, tempo_map, ppq)
    return tempo_map, dyn_map, artic, rubato, errors


def _sanitize_artic(artic, ppq):
    artic = [a for a in artic
             if 0 <= a[0] <= 10_000 * ppq and 0.05 <= a[1] <= 3.0 and -60 <= a[2] <= 60]
    artic.sort(key=lambda a: a[0])
    dedup = []
    for a in artic:
        if dedup and dedup[-1][0] == a[0]:
            dedup[-1] = a
        else:
            dedup.append(a)
    return dedup


def _sanitize_rubato(rub_raw, tempo_map, ppq):
    """raw rows [start, frameLength, intensity, endDate] -> valid paired 6-field rows.
    Enforces: frameLength in {720,1440,2880}, intensity > 0 outside the neutral band,
    end > start with the frame dividing the span, no overlap, and R8 (no tempo
    instruction date strictly inside a frame)."""
    out = []
    prev_end = -1
    for start, frame, intensity, end in sorted(rub_raw, key=lambda r: r[0]):
        if not (0 <= start < end <= 10_000 * ppq):
            continue
        frame = min((720.0, 1440.0, 2880.0), key=lambda f: abs(f - frame))
        if intensity <= 0:
            continue
        intensity = max(0.2, min(3.0, intensity))
        if 0.95 <= intensity <= 1.05:  # neutral band: no-op span, drop
            continue
        span = end - start
        if span < frame or (span % frame) != 0:
            end = start + max(1, round(span / frame)) * frame
        if start < prev_end:  # overlap with previous span
            continue
        r8_violated = any(
            start < t[0] < end and ((t[0] - start) % frame) != 0
            for t in tempo_map
        )
        if r8_violated:
            continue
        out.append([start, frame, intensity, 0.0, 1.0, 1])
        out.append([end, frame, 1.0, 0.0, 1.0, 1])
        prev_end = end
    return out


def decode_tokens(ids, ppq=720):
    """Parse token ids back into a tempo map. Tolerant: malformed instructions are
    skipped; returns (tempo_map, n_parse_errors)."""
    toks = [VOCAB[i] for i in ids if i not in (PAD, BOS, EOS)]
    tempo_map, errors = [], 0
    i = 0

    def read_num(j):
        s = ""
        while j < len(toks) and toks[j] in "0123456789.":
            s += toks[j]
            j += 1
        try:
            return float(s), j
        except ValueError:
            return None, j

    while i < len(toks):
        if toks[i] != "T":
            i += 1
            errors += 1
            continue
        date, i2 = read_num(i + 1)
        if date is None or i2 >= len(toks) or toks[i2] != "B":
            i = i2
            errors += 1
            continue
        bpm, i3 = read_num(i2 + 1)
        if bpm is None or i3 >= len(toks):
            i = i3
            errors += 1
            continue
        if toks[i3] == "C":
            tempo_map.append([date * ppq, bpm, None, None])
            i = i3 + 1
        elif toks[i3] == "R":
            to, i4 = read_num(i3 + 1)
            if to is None or i4 >= len(toks) or toks[i4] != "M":
                i = i4
                errors += 1
                continue
            mta, i5 = read_num(i4 + 1)
            if mta is None:
                i = i5
                errors += 1
                continue
            tempo_map.append([date * ppq, bpm, to, mta])
            i = i5
        else:
            i = i3
            errors += 1

    # sanitize: sorted, deduped dates, sane ranges; force final instruction constant
    tempo_map = [t for t in tempo_map if 0 <= t[0] <= 10_000 * ppq and 1 <= t[1] <= 1000]
    tempo_map.sort(key=lambda t: t[0])
    dedup = []
    for t in tempo_map:
        if dedup and dedup[-1][0] == t[0]:
            dedup[-1] = t
        else:
            dedup.append(t)
    tempo_map = dedup
    for t in tempo_map:
        if t[2] is not None:
            if not (1 <= t[2] <= 1000):
                t[2], t[3] = None, None
            elif t[3] is None or not (0.01 <= t[3] <= 0.99):
                t[3] = 0.5
    if tempo_map and tempo_map[-1][2] is not None:
        tempo_map[-1][2] = None
        tempo_map[-1][3] = None
    return tempo_map, errors
