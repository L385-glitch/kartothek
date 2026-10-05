"""FSRS spaced-repetition scheduler (self-contained, no external deps).

Implements the FSRS-4.5 memory model: each card carries (stability S,
difficulty D, due date). A review with rating r (Again/Hard/Good/Easy)
updates S and D and schedules the next due date. This is the same family
of scheduler Anki adopted; it needs far fewer reviews than SM-2.

Rating enum: 1=Again 2=Hard 3=Good 4=Easy.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

# FSRS-4.5 default weights (11 parameters).
W = [
    0.21, 1.29, 2.33, 8.29,
    1.84, 0.15, 1.01,
    0.00, 1.44, 0.04,
    0.45,
]
REQUEST_RETENTION = 0.9
MAX_INTERVAL = 36500  # days, hard cap


@dataclass
class CardState:
    stability: float = 0.0
    difficulty: float = 0.0
    due: datetime | None = None
    last_review: datetime | None = None
    reps: int = 0
    lapses: int = 0
    # 0=new 1=learning 2=review 3=relearning
    state: int = 0


def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


def _init_stability(rating: int) -> float:
    return _clamp(W[rating - 1], 0.1, 10.0)


def _init_difficulty(rating: int) -> float:
    # D0(G) = w4 - e^(w5*(G-1)) + 1
    return _clamp(W[3] - math.exp(W[4] * (rating - 1)) + 1, 1.0, 10.0)


def _next_difficulty(d: float, rating: int) -> float:
    delta = W[8] * (rating - 3)
    d = d - delta
    # mean reversion toward w4
    d = W[3] * (1 - W[9]) + W[9] * d
    return _clamp(d, 1.0, 10.0)


def _next_recall_stability(s: float, d: float, r: float) -> float:
    # r = requested retention (0.9)
    hard_penalty = W[15] if len(W) > 15 else 1.5
    easy_bonus = W[16] if len(W) > 16 else 1.3
    factor = (
        19 * (1 - r)
        * (s ** -0.5)
        * (math.exp((1 - d) * 0.035) if d > 1 else 1.0)
    )
    return _clamp(s * factor, s * 0.1, 36500)


def _next_forget_stability(s: float, d: float, r: float) -> float:
    # After a lapse, stability drops but stays >= a floor.
    return _clamp(s * (W[10] if len(W) > 10 else 0.3), 0.1, s)


def _interval(s: float) -> int:
    # interval = S * ln(r)/ln(0.9)  ->  days until recall prob = r
    if s <= 0:
        return 0
    iv = s * math.log(REQUEST_RETENTION) / math.log(0.9)
    return max(1, min(int(round(iv)), MAX_INTERVAL))


def _forgetting_prob(s: float, elapsed_days: float) -> float:
    if s <= 0:
        return 1.0
    return (1 + elapsed_days / (9 * s)) ** -1


def review(state: CardState, rating: int, now: datetime | None = None) -> CardState:
    """Apply a review rating and return the updated state."""
    now = now or datetime.now(timezone.utc)
    rating = _clamp(int(rating), 1, 4)

    if state.state == 0:  # new card
        s = _init_stability(rating)
        d = _init_difficulty(rating)
        if rating == 1:
            # Again on a new card -> relearn in 1 min (kept simple: 0-day, relearn)
            next_due = now + timedelta(minutes=10)
            new_state = 3
        else:
            iv = _interval(s)
            next_due = now + timedelta(days=iv)
            new_state = 2 if iv > 1 else 1
        return CardState(stability=s, difficulty=d, due=next_due,
                         last_review=now, reps=1, lapses=0, state=new_state)

    # Existing card.
    elapsed = 0.0
    if state.due and state.last_review:
        elapsed = max(0.0, (now - state.last_review).total_seconds() / 86400.0)
    r = _forgetting_prob(state.stability, elapsed)

    d = _next_difficulty(state.difficulty, rating)

    if rating == 1:  # Again -> lapse
        s = _next_forget_stability(state.stability, d, r)
        next_due = now + timedelta(minutes=10)
        new_state = 3
        lapses = state.lapses + 1
    else:
        s = _next_recall_stability(state.stability, d, r)
        iv = _interval(s)
        next_due = now + timedelta(days=iv)
        new_state = 2 if iv > 1 else 1
        lapses = state.lapses

    return CardState(stability=s, difficulty=d, due=next_due, last_review=now,
                     reps=state.reps + 1, lapses=lapses, state=new_state)


def _aware(dt: datetime | None) -> datetime | None:
    """Normalize a possibly-naive datetime to UTC-aware (SQLite strips tz)."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def is_due(state: CardState, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    if state.state == 0:
        return True
    due = _aware(state.due)
    return due is not None and due <= now


def due_in_days(state: CardState, now: datetime | None = None) -> float:
    now = now or datetime.now(timezone.utc)
    if state.state == 0:
        return 0.0
    due = _aware(state.due)
    if not due:
        return 0.0
    return (due - now).total_seconds() / 86400.0
