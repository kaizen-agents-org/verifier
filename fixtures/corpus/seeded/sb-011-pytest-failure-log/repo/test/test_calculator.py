from src.calculator import divide_round_down


def test_divide_round_down() -> None:
    assert divide_round_down(5, 2) == 2
