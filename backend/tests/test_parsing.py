from app.parsing import choose_winner, extract_constraints, parse_consensus, parse_interrogation


def test_parse_interrogation_token():
    assert parse_interrogation("Stop. [INTERROGATE: budget] How much?") == ["budget"]


def test_parse_consensus_token():
    assert parse_consensus("[CONSENSUS_REACHED]: Order tacos") == "Order tacos"


def test_choose_winner():
    assert choose_winner("Winner: Vibe-Check because joy matters") == "Vibe-Check"
    assert choose_winner("Optimizer wins on cost") == "Optimizer"


def test_extract_constraints():
    constraints = extract_constraints("Budget is $50. Audience is college hackers. Vibe is chaotic.")
    assert constraints["budget"] == "$50"
    assert constraints["audience"] == "college hackers"
    assert constraints["audience_vibe"] == "chaotic"

