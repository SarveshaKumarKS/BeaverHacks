from pathlib import Path

from app import social_debt
from app.social_debt import debt_modifier_for, get_social_debt, record_consensus


def test_social_debt_roundtrip(tmp_path: Path, monkeypatch):
    path = tmp_path / "social_debt.json"
    monkeypatch.setattr(social_debt, "DATA_DIR", tmp_path)
    monkeypatch.setattr(social_debt, "SOCIAL_DEBT_PATH", path)

    first = get_social_debt("group")
    assert first.debt_balance == 0

    updated = record_consensus("group", "Pizza or sushi?", "Optimizer")
    assert updated.debt_balance == 1
    assert get_social_debt("group").history[0].winner == "Optimizer"


def test_debt_modifier_copy():
    assert "Optimizer is owed" in debt_modifier_for(1)
    assert "Vibe-Check is owed" in debt_modifier_for(-1)
    assert "No social debt" in debt_modifier_for(0)

