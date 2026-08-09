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
         "U", "F", "I", "X", "A", "L", "W",
         # v4 additions (appended so v1/v2/v3 token ids stay stable), CANONICAL §11:
         # movement    'G'<dateDelta>['Z'<positionCC>]('C'|'R'<toCC>['Q'<curv>'P'<prot>])
         # asynchrony  'Y'<date>'J'<offsetMs>
         "G", "Z", "Y", "J"]
TOK2ID = {t: i for i, t in enumerate(VOCAB)}
PAD, BOS, EOS = 0, 1, 2
V1_VOCAB_SIZE = 19
V2_VOCAB_SIZE = 24  # frozen: runs/v2 ckpts were trained with exactly these 24 tokens
V3_VOCAB_SIZE = 31  # frozen: runs/v3 and runs/v31 ckpts (incl. the live v3.1 run)
V4_VOCAB_SIZE = 35  # frozen: G Z Y J appended for v4

#: CANONICAL M3 — movement boundaries live on a 1/4-beat grid, and §11 encodes a movement
#: date as an integer delta in those units. 720/4 = 180 ticks.
MOVEMENT_GRID_DIVISOR = 4
#: CANONICAL M4 — the canonical position alphabet is the 128 integer CC values.
CC_MAX = 127
#: `MovementData`'s field defaults (fork-verified). M9 omits an attribute equal to them.
#: These are NOT the dynamics defaults: `DynamicsData.curvature/protraction` are `null`,
#: which `_sanitize_dyn` turns into 0.0 — copying that here would silently reshape every
#: pedal ramp, so the two productions branch even though they share the Q/P tokens.
MOVEMENT_DEFAULT_CURVATURE = 0.4
MOVEMENT_DEFAULT_PROTRACTION = 0.0

#: The map order of the v4 linear grammar (H1(a)). Frozen: a decoder cannot recover a
#: different order, so this cannot be changed after the first trained checkpoint.
V4_MAP_ORDER = ("tempo", "dynamics", "rubato", "articulation", "movement", "asynchrony")
#: The v4 *training* target is the subset whose maps the DSL decoder is responsible for.
#: articulation and movement are supervised per note instead (they cost a median 186 and
#: 408 tokens per piece against 183 for all of this, and articulation's date-keyed label
#: was the wrong representation anyway — see CANONICAL A6).
V4_TRAINING_MAPS = ("tempo", "dynamics", "rubato", "asynchrony")


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


# =======================================================================================
#  v4 — CANONICAL §11: movement (G/Z) and asynchrony (Y/J) on top of the v3 grammar
# =======================================================================================
#
# Grammar (linear, digit-tokenised, map order pinned by H1(a) and frozen):
#
#   piece        := tempo* dynamics* rubato* articulation* movement* asynchrony*
#   tempo        := 'T' date 'B' bpm ( 'C' | 'R' to 'M' meanTempoAt )
#   dynamics     := 'D' date 'V' volume ( 'C' | 'R' to 'Q' curvature 'P' protraction )
#   rubato       := 'U' date 'F' frameBeats 'I' intensity 'X' endDate
#   articulation := 'A' date 'L' relativeDuration 'W' velocityChange
#   movement     := 'G' dateDelta [ 'Z' position ] ( 'C' | 'R' to [ 'Q' curv 'P' prot ] )
#   asynchrony   := 'Y' date 'J' offsetMs
#
# Movement specifics, all of them load-bearing (CANONICAL §11 / M3 / M4 / M9 / M1):
#   * `dateDelta` is an integer count of 1/4-beat units since the previous instruction, not
#     an absolute beat date. Absolute fractional-beat dates cost a median 1.36x the tokens
#     and carry no more information — a chain is read left to right anyway.
#   * `position` / `to` are integer CC values 0..127, i.e. `round(127*p)`, not 0..1 decimals.
#     `k/127` round-trips to the same double, so the re-render is bit-exact.
#   * `Q`/`P` are omitted when they equal MovementData's 0.4/0.0 defaults and restored on
#     decode. They are emitted as a pair, exactly as the grammar spells them.
#   * the terminator is the last instruction and is written `G <delta> C` with **no** `Z`:
#     `renderMovementToMap` never renders the last instruction, so its position is not an
#     observable. The decoder reconstructs it as the value in force (the previous
#     instruction's `transition.to`, or its `position` after a plateau) — verified
#     reconstructible on 60/60 pilot pieces.
#
# NOT expressible: the `controller` attribute. §11 froze the vocabulary at 35 tokens with no
# controller slot, so the movement production means the *sustain* chain (M7's other legal
# value, "soft", has no v4 sampler and would need a v5 vocabulary extension). `encode` says
# so loudly rather than dropping the distinction.


def _cc_int(position):
    """CANONICAL M4: the canonical alphabet is the 128 integer CC values."""
    return int(round(CC_MAX * position))


def _enc_tempo_rows(tempo_map, ppq):
    toks = []
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
    return toks


def _enc_dyn_rows(dyn_map, ppq):
    toks = []
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
    return toks


def _enc_rubato_rows(rubato, ppq):
    toks = []
    rub = sorted(rubato or [], key=lambda r: r[0])
    i = 0
    while i < len(rub):
        row = rub[i]
        if row[2] == 1.0:                        # stray terminator without opener: skip
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
    return toks


def _artic_streams(artic):
    """``articulation`` -> ``[(part, [[date, relDur, velChange], ...]), ...]`` in part order.

    Accepts the two shapes the program produces: v3's flat 3-wide rows (one implicit part)
    and v4.1's 4-wide rows carrying the part number (CANONICAL A6). Mixed widths are a
    corrupt map, not a shape to guess at.
    """
    rows = list(artic or [])
    if not rows:
        return []
    widths = {len(r) for r in rows}
    if widths == {3}:
        return [(1, sorted(rows, key=lambda a: a[0]))]
    if widths != {4}:
        raise ValueError(f"articulation rows mix widths {sorted(widths)}; expected all 3 "
                         f"(single part) or all 4 (part-local, A6)")
    by_part = {}
    for date, rel_dur, vel_change, part in rows:
        by_part.setdefault(part, []).append([date, rel_dur, vel_change])
    return [(p, sorted(by_part[p], key=lambda a: a[0])) for p in sorted(by_part)]


def _enc_artic_rows(artic, ppq):
    toks = []
    for _part, rows in _artic_streams(artic):
        for date, rel_dur, vel_change in rows:
            toks.append("A")
            toks += _num_tokens(date / ppq)   # NOT rounded: artic dates sit on beat fractions
            toks.append("L")
            toks += _num_tokens(rel_dur)
            toks.append("W")
            toks += _num_tokens(vel_change)
    return toks


def _enc_movement_rows(movement, ppq):
    toks = []
    mov = list(movement or [])
    if not mov:
        return toks
    grid = ppq / MOVEMENT_GRID_DIVISOR
    prev_date = 0.0
    for i, row in enumerate(mov):
        date, position, to = row[0], row[1], row[2]
        curv = row[3] if len(row) > 3 else None
        prot = row[4] if len(row) > 4 else None
        controller = row[5] if len(row) > 5 else "sustain"
        if controller not in (None, "sustain"):
            raise ValueError(
                f"movement controller {controller!r} is not expressible in the v4 DSL: §11 "
                f"froze the vocabulary with no controller slot, so the movement production "
                f"means the sustain chain")
        delta = date - prev_date
        if delta < 0:
            raise ValueError(f"movement dates not ascending at {date}")
        steps = round(delta / grid)
        if abs(steps * grid - delta) > 1e-9:
            raise ValueError(f"movement date {date} is off the 1/4-beat grid (M3)")
        toks.append("G")
        toks += _num_tokens(steps)
        if i != len(mov) - 1:                  # M1/§11: the terminator carries no `Z`
            toks.append("Z")
            toks += _num_tokens(_cc_int(position))
        if to is None:
            toks.append("C")
        else:
            toks.append("R")
            toks += _num_tokens(_cc_int(to))
            c = MOVEMENT_DEFAULT_CURVATURE if curv is None else curv
            p = MOVEMENT_DEFAULT_PROTRACTION if prot is None else prot
            if c != MOVEMENT_DEFAULT_CURVATURE or p != MOVEMENT_DEFAULT_PROTRACTION:  # M9
                toks.append("Q")
                toks += _num_tokens(c)
                toks.append("P")
                toks += _num_tokens(p)
        prev_date = date
    return toks


def _enc_asyn_rows(asynchrony, ppq):
    toks = []
    for date, offset in sorted(asynchrony or [], key=lambda a: a[0]):
        toks.append("Y")
        toks += _num_tokens(round(date / ppq))
        toks.append("J")
        toks += _num_tokens(round(offset))          # Y2: integer milliseconds
    return toks


def encode_piece_v4(maps, subset="training", ppq=720):
    """Encode a v4 piece to token ids.

    ``maps`` is the record's map dict (``tempo``/``dynamics``/``rubato``/``articulation``/
    ``movement``/``asynchrony``; missing keys are empty maps).

    ``subset``
        ``"training"``  the four maps the v4 DSL decoder is trained on — tempo, dynamics,
                        rubato, asynchrony (median 183 tokens on the pilot).
        ``"full"``      every map of CANONICAL §11, i.e. the description length the MDL
                        metric and the MPM exporter mean. Median ~768 tokens; this is the
                        representation, not the training target.
    """
    if subset not in ("training", "full"):
        raise ValueError(f"subset must be 'training' or 'full', got {subset!r}")
    want = V4_MAP_ORDER if subset == "full" else V4_TRAINING_MAPS
    enc = {
        "tempo": _enc_tempo_rows,
        "dynamics": _enc_dyn_rows,
        "rubato": _enc_rubato_rows,
        "articulation": _enc_artic_rows,
        "movement": _enc_movement_rows,
        "asynchrony": _enc_asyn_rows,
    }
    toks = ["<bos>"]
    for name in V4_MAP_ORDER:                       # H1(a): the pinned order, always
        if name in want:
            toks += enc[name](maps.get(name) or [], ppq)
    toks.append("<eos>")
    return [TOK2ID[t] for t in toks]


def decode_piece_v4(ids, subset="training", ppq=720, artic_part_sizes=None):
    """Parse a v4 token stream into ``(maps, n_errors)``. Tolerant and sanitised.

    ``maps`` has the six ``V4_MAP_ORDER`` keys; maps outside ``subset`` come back empty.

    ``artic_part_sizes``
        the number of articulation rows belonging to each part, in part order. The token
        stream cannot carry it — §11 froze the vocabulary with no part token, and the
        streams are concatenated — so a caller that needs the 4-wide part-local rows back
        (round-trip proofs, MPM export) supplies the split it already knows. Without it,
        articulation comes back as 3-wide rows, which is what a single-part piece and every
        v3 consumer want.
    """
    if subset not in ("training", "full"):
        raise ValueError(f"subset must be 'training' or 'full', got {subset!r}")
    toks = [VOCAB[i] for i in ids if 0 <= i < len(VOCAB) and i not in (PAD, BOS, EOS)]
    tempo_map, dyn_map, artic, rub_raw, mov_raw, asyn_raw = [], [], [], [], [], []
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
        if kind in ("T", "D"):
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
                vals, i4 = fields(i3, "RM" if kind == "T" else "RQP")
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
        elif kind == "G":
            delta, i2 = read_num(i + 1)
            if delta is None:
                i = max(i2, i + 1)
                errors += 1
                continue
            position = None
            if i2 < len(toks) and toks[i2] == "Z":
                position, i2 = read_num(i2 + 1)
                if position is None:
                    i = i2
                    errors += 1
                    continue
            if i2 >= len(toks):
                errors += 1
                break
            if toks[i2] == "C":
                mov_raw.append([delta, position, None, None, None])
                i = i2 + 1
            elif toks[i2] == "R":
                to, i3 = read_num(i2 + 1)
                if to is None:
                    i = i3
                    errors += 1
                    continue
                # H1(b): Q/P are OPTIONAL here and default to 0.4/0.0 — the movement
                # defaults, not the dynamics ones (`_sanitize_dyn`'s 0.0 would flatten
                # every ramp's S-curve).
                curv, prot = MOVEMENT_DEFAULT_CURVATURE, MOVEMENT_DEFAULT_PROTRACTION
                if i3 < len(toks) and toks[i3] == "Q":
                    vals, i4 = fields(i3, "QP")
                    if vals is None:
                        i = i4
                        errors += 1
                        continue
                    curv, prot = vals[0], vals[1]
                    i3 = i4
                mov_raw.append([delta, position, to, curv, prot])
                i = i3
            else:
                i = i2
                errors += 1
        elif kind == "Y":
            date, i2 = read_num(i + 1)
            vals, i3 = fields(i2, "J") if date is not None else (None, i2)
            if vals is None:
                i = max(i3, i + 1)
                errors += 1
                continue
            asyn_raw.append([date * ppq, vals[0]])
            i = i3
        else:
            i += 1
            errors += 1

    tempo_map = _sanitize_tempo(tempo_map, ppq)
    dyn_map = _sanitize_dyn(dyn_map, ppq)
    # Articulation is sanitised PER STREAM. `_sanitize_artic` sorts and dedupes by date,
    # which is right inside one part-local map and wrong across the concatenation of
    # several: a global sort interleaves the parts and the split can no longer recover
    # which map a row came from.
    if artic_part_sizes is not None:
        artic = [row for part, rows in _artic_streams(_split_artic_rows(artic,
                                                                       artic_part_sizes))
                 for row in ([*r, part] for r in _sanitize_artic(rows, ppq))]
    else:
        artic = _sanitize_artic(artic, ppq)
    rubato = _sanitize_rubato(rub_raw, tempo_map, ppq)
    movement = _sanitize_movement(mov_raw, ppq)
    asynchrony = _sanitize_asyn(asyn_raw, ppq)
    maps = {"tempo": tempo_map, "dynamics": dyn_map, "rubato": rubato,
            "articulation": artic, "movement": movement, "asynchrony": asynchrony}
    if subset != "full":
        for name in V4_MAP_ORDER:
            if name not in V4_TRAINING_MAPS:
                maps[name] = []
    return maps, errors


def _split_artic_rows(artic, part_sizes):
    """Re-attach the part column that the token stream cannot carry (see decode's docstring).

    ``part_sizes`` is ``[(part, n), ...]`` or a plain ``[n, ...]`` (parts numbered from 1).
    Rows beyond the declared total keep the last part — a decode that emitted more
    articulations than the split expects is a prediction, not a corruption, and dropping the
    tail silently would understate the model's output.
    """
    pairs = [(p, n) for p, n in part_sizes] if part_sizes and isinstance(
        part_sizes[0], (tuple, list)) else [(i + 1, n) for i, n in enumerate(part_sizes)]
    out, k = [], 0
    for part, n in pairs:
        for row in artic[k:k + n]:
            out.append([row[0], row[1], row[2], part])
        k += n
    last_part = pairs[-1][0] if pairs else 1
    for row in artic[k:]:
        out.append([row[0], row[1], row[2], last_part])
    return out


def _sanitize_movement(mov_raw, ppq):
    """raw rows ``[delta_quarter_beats, positionCC|None, toCC|None, curv, prot]`` -> canonical
    6-field movement rows ``[date, position, to|None, curvature|None, protraction|None,
    controller]``.

    Enforces, in this order: non-negative integer deltas on the M3 grid; positions and
    transition targets on the 0..127 CC alphabet (M4); no degenerate transition (M5); the
    terminator's position reconstructed as the value in force (§11); a final instruction
    that is constant (M1). A chain of fewer than two instructions renders nothing at all, so
    it is dropped rather than half-repaired.
    """
    grid = ppq / MOVEMENT_GRID_DIVISOR
    rows, date = [], 0.0
    for delta, position, to, curv, prot in mov_raw:
        if delta is None or delta < 0 or delta > 10_000 * MOVEMENT_GRID_DIVISOR:
            continue
        date = date + round(delta) * grid
        pos_cc = None if position is None else max(0, min(CC_MAX, int(round(position))))
        to_cc = None if to is None else max(0, min(CC_MAX, int(round(to))))
        if to_cc is not None and pos_cc is not None and to_cc == pos_cc:
            to_cc = None                                    # M5: a plateau is a constant
        c = 0.0 if curv is None else max(0.0, min(1.0, curv))
        p = 0.0 if prot is None else max(-1.0, min(1.0, prot))
        row = [date, pos_cc, to_cc, c if to_cc is not None else None,
               p if to_cc is not None else None]
        if rows and rows[-1][0] == date:        # duplicate date: meico's map is last-wins
            rows[-1] = row
        else:
            rows.append(row)
    if len(rows) < 2:
        return []
    # §11: only the terminator may omit its position; anything else that did is a decode
    # artefact and inherits the value in force, which is what meico's (defective)
    # getPreviousPosition would have tried to do.
    in_force = 0
    for r in rows:
        if r[1] is None:
            r[1] = in_force
        in_force = r[2] if r[2] is not None else r[1]
    prev = rows[-2]                             # M1: the terminator is constant, and its
    rows[-1][1] = prev[2] if prev[2] is not None else prev[1]   # position is the value in
    rows[-1][2] = rows[-1][3] = rows[-1][4] = None              # force where the chain ends
    return [[r[0], r[1] / CC_MAX, None if r[2] is None else r[2] / CC_MAX, r[3], r[4],
             "sustain"] for r in rows]


def _sanitize_asyn(asyn_raw, ppq):
    """raw ``[date, offsetMs]`` -> canonical rows. Y2 integer ms, Y3 deadband and cap, Y4
    beat grid / >=4-beat segments / merge adjacent equals. A map with nothing at date 0
    gets one: meico's implicit offset there is 0, and spelling it out is what makes the
    first segment's boundary a prediction rather than a default."""
    rows = []
    for date, offset in sorted(asyn_raw, key=lambda a: a[0]):
        if not (0 <= date <= 10_000 * ppq):
            continue
        off = int(round(offset))
        if abs(off) > 60:                                    # Y3 cap
            off = 60 if off > 0 else -60
        if abs(off) < 5:                                     # Y3 deadband
            off = 0
        d = round(date / ppq) * ppq                          # Y4 beat grid
        if rows and d - rows[-1][0] < 4 * ppq:               # Y4 minimum segment
            continue
        if rows and rows[-1][1] == off:                      # G8
            continue
        rows.append([float(d), off])
    if rows and rows[0][0] != 0:
        rows.insert(0, [0.0, 0])
    if len(rows) == 1 and rows[0][1] == 0:
        return []
    return rows
