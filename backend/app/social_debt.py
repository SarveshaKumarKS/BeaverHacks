from __future__ import annotations

import json
from pathlib import Path

from .models import AgentName, DebtHistoryEntry, SocialDebt

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
SOCIAL_DEBT_PATH = DATA_DIR / "social_debt.json"


def _read_all() -> dict[str, dict]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not SOCIAL_DEBT_PATH.exists():
        return {}
    with SOCIAL_DEBT_PATH.open("r", encoding="utf-8") as handle:
        raw = json.load(handle)
    return raw if isinstance(raw, dict) else {}


def _write_all(data: dict[str, dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = SOCIAL_DEBT_PATH.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
    tmp_path.replace(SOCIAL_DEBT_PATH)


def get_social_debt(group_id: str) -> SocialDebt:
    all_debt = _read_all()
    entry = all_debt.get(group_id)
    if not entry:
        return SocialDebt(group_id=group_id)
    return SocialDebt.model_validate(entry)


def save_social_debt(debt: SocialDebt) -> SocialDebt:
    all_debt = _read_all()
    all_debt[debt.group_id] = debt.model_dump(mode="json")
    _write_all(all_debt)
    return debt


def debt_modifier_for(balance: float) -> str:
    if balance > 0:
        return "Optimizer is owed social debt from prior debates. Vibe-Check should concede more easily."
    if balance < 0:
        return "Vibe-Check is owed social debt from prior debates. Optimizer should concede more easily."
    return "No social debt yet. Debate on merit."


def record_consensus(group_id: str, dilemma: str, winner: AgentName, impact_score: float = 1.0) -> SocialDebt:
    debt = get_social_debt(group_id)
    delta = impact_score if winner == "Optimizer" else -impact_score
    debt.debt_balance = round(debt.debt_balance + delta, 2)
    debt.history.append(
        DebtHistoryEntry(
            dilemma=dilemma,
            winner=winner,
            impact_score=impact_score,
        )
    )
    return save_social_debt(debt)

