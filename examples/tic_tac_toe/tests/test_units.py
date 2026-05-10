"""Unit tests for tic_tac_toe.py — run with `pytest` from this folder.

Compile the slate `game` doc first (it writes tic_tac_toe.py at the example
root), then `pytest examples/tic_tac_toe/tests`.
"""
import importlib.util
import os
import pytest

HERE = os.path.dirname(__file__)
COMPILED = os.path.abspath(os.path.join(HERE, '..', 'tic_tac_toe.py'))


def _load_module():
    if not os.path.exists(COMPILED):
        pytest.skip(f"{COMPILED} not yet compiled — run COMPILE on the game doc in slate")
    spec = importlib.util.spec_from_file_location('tic_tac_toe', COMPILED)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_make_board():
    """make_board returns a fresh 9-cell empty board."""
    m = _load_module()
    assert m.make_board() == [' '] * 9
    # Pure: separate calls return distinct lists.
    assert m.make_board() is not m.make_board()


def test_is_winning_line():
    """is_winning_line returns the winning mark or None."""
    m = _load_module()
    board = ['X', 'X', 'X', ' ', ' ', ' ', ' ', ' ', ' ']
    assert m.is_winning_line(board, (0, 1, 2)) == 'X'
    assert m.is_winning_line(board, (3, 4, 5)) is None
    # All-empty line should NOT count as a win.
    assert m.is_winning_line(m.make_board(), (0, 1, 2)) is None


def test_check_winner():
    """check_winner aggregates over all WINNING_LINES + detects draws."""
    m = _load_module()
    assert m.check_winner(m.make_board()) is None
    assert m.check_winner(['X', 'X', 'X', ' ', ' ', ' ', ' ', ' ', ' ']) == 'X'
    assert m.check_winner([' ', ' ', ' ', ' ', ' ', ' ', 'O', 'O', 'O']) == 'O'
    # Diagonal.
    assert m.check_winner(['X', ' ', ' ', ' ', 'X', ' ', ' ', ' ', 'X']) == 'X'
    # Full board, no winner → draw.
    full_draw = ['X', 'O', 'X',
                 'X', 'O', 'O',
                 'O', 'X', 'X']
    assert m.check_winner(full_draw) == 'draw'


def test_valid_moves():
    """valid_moves returns the indices of empty cells, in order."""
    m = _load_module()
    assert m.valid_moves(m.make_board()) == list(range(9))
    assert m.valid_moves(['X', ' ', 'O', ' ', ' ', ' ', ' ', ' ', ' ']) == [1, 3, 4, 5, 6, 7, 8]
    assert m.valid_moves(['X'] * 9) == []


def test_apply_move():
    """apply_move is pure and rejects illegal moves."""
    m = _load_module()
    board = m.make_board()
    new = m.apply_move(board, 4, 'X')
    assert new[4] == 'X'
    assert board[4] == ' '  # original unchanged
    with pytest.raises(ValueError):
        m.apply_move(new, 4, 'O')      # already taken
    with pytest.raises(ValueError):
        m.apply_move(board, 99, 'X')   # out of range


def test_current_player():
    """current_player: X first, then alternation by mark count."""
    m = _load_module()
    assert m.current_player(m.make_board()) == 'X'
    assert m.current_player(['X'] + [' '] * 8) == 'O'
    assert m.current_player(['X', 'O'] + [' '] * 7) == 'X'
    assert m.current_player(['X', 'O', 'X'] + [' '] * 6) == 'O'


def test_ai_player_random():
    """ai_player_random returns an index that's in valid_moves."""
    m = _load_module()
    board = ['X', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ']
    for _ in range(20):
        move = m.ai_player_random(board)
        assert move in m.valid_moves(board)
    with pytest.raises(ValueError):
        m.ai_player_random(['X'] * 9)


def test_play_one_game_ai_vs_ai_terminates():
    """play_one_game with no human always terminates with a known result."""
    m = _load_module()
    for _ in range(20):
        outcome = m.play_one_game(human_plays=None, verbose=False)
        assert outcome in ('X', 'O', 'draw')
