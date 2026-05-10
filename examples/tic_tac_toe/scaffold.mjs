import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Generator for examples/tic_tac_toe/tic_tac_toe.slate.json.
 *
 * Run with: `node examples/tic_tac_toe/scaffold.mjs > examples/tic_tac_toe/tic_tac_toe.slate.json`
 *
 * Maintains the example as readable code (multi-line python strings here)
 * rather than as escape-encoded JSON. UUIDs are deterministic (`ttt-...`)
 * so regenerating the file produces a clean diff: only the cards that
 * actually changed show up.
 *
 * v0.2 phase 1 schema (no `targetId`, no `language` — those come in phase 7).
 * Class nesting (issue #13, phase 5) not used here either; tic-tac-toe is
 * small enough that pure functions read cleaner than a class would.
 */

const ISO = '2026-05-09T22:00:00.000Z';

// ───────────────────────── game doc cards ────────────────────────────

const game_header_src = `"""Functional tic-tac-toe — board is a flat list of 9 cells, each ' ', 'X', or 'O'."""
import random
from typing import List, Optional, Tuple

# Index layout:
#   0 | 1 | 2
#  ---+---+---
#   3 | 4 | 5
#  ---+---+---
#   6 | 7 | 8
WINNING_LINES: Tuple[Tuple[int, int, int], ...] = (
    (0, 1, 2), (3, 4, 5), (6, 7, 8),  # rows
    (0, 3, 6), (1, 4, 7), (2, 5, 8),  # cols
    (0, 4, 8), (2, 4, 6),              # diagonals
)`;

const make_board_src = `def make_board() -> List[str]:
    """Return an empty 3x3 board as a flat list of 9 single-space strings."""
    return [' '] * 9`;

const render_board_src = `def render_board(board: List[str]) -> str:
    """Format \`board\` as a printable 3x3 grid with row separators."""
    rows = [' | '.join(board[i:i + 3]) for i in range(0, 9, 3)]
    return '\\n---------\\n'.join(rows)`;

const is_winning_line_src = `def is_winning_line(board: List[str], line: Tuple[int, int, int]) -> Optional[str]:
    """Return 'X' or 'O' if all three cells in \`line\` are non-empty and match. Else None."""
    a, b, c = line
    if board[a] != ' ' and board[a] == board[b] == board[c]:
        return board[a]
    return None`;

const check_winner_src = `def check_winner(board: List[str]) -> Optional[str]:
    """Return 'X', 'O', 'draw', or None given the current @board.

    Walks every line in WINNING_LINES via @is_winning_line. If no winner and
    no empty cells remain, the game is a draw. Otherwise still in progress.
    """
    for line in WINNING_LINES:
        winner = is_winning_line(board, line)
        if winner is not None:
            return winner
    if ' ' not in board:
        return 'draw'
    return None`;

const valid_moves_src = `def valid_moves(board: List[str]) -> List[int]:
    """Return cell indices (0-8) that are still empty on \`board\`."""
    return [i for i, cell in enumerate(board) if cell == ' ']`;

const apply_move_src = `def apply_move(board: List[str], index: int, player: str) -> List[str]:
    """Return a NEW board with \`player\` placed at \`index\`.

    Pure: does not mutate the input. Raises ValueError on illegal move
    (cell already occupied or index out of range).
    """
    if not 0 <= index < 9:
        raise ValueError(f"Index {index} out of range (must be 0-8)")
    if board[index] != ' ':
        raise ValueError(f"Cell {index} already taken by {board[index]!r}")
    new_board = list(board)
    new_board[index] = player
    return new_board`;

const current_player_src = `def current_player(board: List[str]) -> str:
    """X always plays first. Whoever has placed fewer marks plays next."""
    x_count = board.count('X')
    o_count = board.count('O')
    return 'X' if x_count <= o_count else 'O'`;

const ai_player_random_src = `def ai_player_random(board: List[str]) -> int:
    """Pick a uniformly-random move from @valid_moves on the given @board."""
    moves = valid_moves(board)
    if not moves:
        raise ValueError("No valid moves; game is over")
    return random.choice(moves)`;

const human_player_input_src = `def human_player_input(board: List[str]) -> int:
    """Read a move (0-8) from stdin until the player provides a legal index.

    Reprompts on non-integer input and on cells that aren't currently in
    @valid_moves. Returns the chosen index.
    """
    legal = set(valid_moves(board))
    while True:
        raw = input(f"Your move (one of {sorted(legal)}): ")
        try:
            index = int(raw.strip())
        except ValueError:
            print(f"  '{raw}' is not an integer — try again.")
            continue
        if index not in legal:
            print(f"  Cell {index} is not available — try again.")
            continue
        return index`;

const play_one_game_src = `def play_one_game(human_plays: Optional[str] = None, verbose: bool = True) -> str:
    """Play a single game and return the result ('X', 'O', or 'draw').

    \`human_plays\`:
      - 'X' or 'O' → that side is controlled via @human_player_input
      - None       → both sides are @ai_player_random (good for smoke tests)

    Loop:
      1. Print the @render_board (if verbose).
      2. @check_winner — if decided, return.
      3. @current_player picks who's up.
      4. Their move comes from @human_player_input or @ai_player_random.
      5. @apply_move produces the next board; goto 1.
    """
    board = make_board()
    while True:
        if verbose:
            print(render_board(board))
            print()
        outcome = check_winner(board)
        if outcome is not None:
            if verbose:
                print(f"Result: {outcome}")
            return outcome
        player = current_player(board)
        if player == human_plays:
            move = human_player_input(board)
        else:
            move = ai_player_random(board)
            if verbose:
                print(f"  {player} (random AI) plays {move}")
        board = apply_move(board, move, player)`;

const main_src = `def main() -> None:
    """Entry point. Default: AI vs AI smoke run, prints the result.

    To play interactively, replace this with @play_one_game(human_plays='X').
    """
    play_one_game(human_plays=None, verbose=True)


if __name__ == '__main__':
    main()`;

// ───────────────────────── external tests file ───────────────────
// Tests live OUTSIDE slate — they're a static pytest file you run yourself
// against the compiled tic_tac_toe.py. Slate just generates the game; you run
// `pytest examples/tic_tac_toe/tests` from the terminal to grade it.
const tests_file_src = `"""Unit tests for tic_tac_toe.py — run with \`pytest\` from this folder.

Compile the slate \`game\` doc first (it writes tic_tac_toe.py at the example
root), then \`pytest examples/tic_tac_toe/tests\`.
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
`;

// ───────────────────────── assembly ─────────────────────────────────

function card({ id, title, src, prompt, links = [], cardType = 'code', kind = 'body' }) {
    return {
        id,
        title,
        content: src,
        prompt,
        images: [],
        links,
        cardType,
        kind,
    };
}

const project = {
    id: 'ttt-project-001',
    name: 'tic_tac_toe',
    docs: [
        // ── game doc → compiles to examples/tic_tac_toe/tic_tac_toe.py ──
        {
            id: 'ttt-doc-game-001',
            title: 'game',
            summary: null,
            destination: '',
            createdAt: ISO,
            updatedAt: ISO,
            cardCount: 12,
            cards: [
                card({ id: 'ttt-game-000', title: '__header__', src: game_header_src, prompt: '', cardType: 'markdown', kind: 'header' }),
                card({ id: 'ttt-game-001', title: 'make_board', src: make_board_src,
                       prompt: 'A factory that returns an empty tic-tac-toe board as a flat list of 9 single-space strings. No arguments. Pure.' }),
                card({ id: 'ttt-game-002', title: 'render_board', src: render_board_src,
                       prompt: 'Format a board (list of 9 cells) as a printable 3-row grid with `|` between cells and `---------` between rows. Returns a string.' }),
                card({ id: 'ttt-game-003', title: 'is_winning_line', src: is_winning_line_src,
                       prompt: "Given a board and a line (3 indices), return 'X' or 'O' if all three cells are non-empty and match; else None." }),
                card({ id: 'ttt-game-004', title: 'check_winner', src: check_winner_src,
                       links: ['is_winning_line'],
                       prompt: "Determine the game state. Walk every line in WINNING_LINES via @is_winning_line. Return 'X', 'O', 'draw', or None (still in progress)." }),
                card({ id: 'ttt-game-005', title: 'valid_moves', src: valid_moves_src,
                       prompt: 'Return the cell indices (0-8) that are still empty on the board. Used by @apply_move callers and by @ai_player_random.' }),
                card({ id: 'ttt-game-006', title: 'apply_move', src: apply_move_src,
                       prompt: 'Pure: return a NEW board with `player` placed at `index`. Raise ValueError if the cell is occupied or the index is out of range.' }),
                card({ id: 'ttt-game-007', title: 'current_player', src: current_player_src,
                       prompt: 'X always plays first; whoever has placed fewer marks plays next. Returns the mark string.' }),
                card({ id: 'ttt-game-008', title: 'ai_player_random', src: ai_player_random_src,
                       links: ['valid_moves'],
                       prompt: 'Pick a uniformly-random move from @valid_moves on the given board. Raise ValueError if there are no valid moves.' }),
                card({ id: 'ttt-game-009', title: 'human_player_input', src: human_player_input_src,
                       links: ['valid_moves'],
                       prompt: "Read a move (0-8) from stdin until the player provides a legal index from @valid_moves. Reprompt on non-integer input and on illegal cells." }),
                card({ id: 'ttt-game-010', title: 'play_one_game', src: play_one_game_src,
                       links: ['make_board', 'render_board', 'check_winner', 'current_player', 'human_player_input', 'ai_player_random', 'apply_move'],
                       prompt: "Play one game and return the result ('X', 'O', or 'draw'). Loop: render via @render_board, check via @check_winner, ask @current_player, route to @human_player_input or @ai_player_random, then @apply_move. If `human_plays` is None, both sides are AI." }),
                card({ id: 'ttt-game-011', title: 'main', src: main_src,
                       links: ['play_one_game'],
                       prompt: 'Entry point. Default: AI vs AI smoke run via @play_one_game with `human_plays=None`. To play interactively, swap to `human_plays="X"`.' }),
            ],
        },
    ],
    createdAt: ISO,
    updatedAt: ISO,
    docCount: 1,
    totalCards: 12,
};

/**
 * Return a deep clone of the project with every body card's `content` blanked
 * (and cardType reset to markdown). Use this to test the GENERATE ALL workflow
 * end-to-end — the prompts and dependency graph are identical to the filled
 * variant, so a working local model should be able to reconstruct usable code.
 */
function blankBodies(p) {
    const clone = JSON.parse(JSON.stringify(p));
    for (const doc of clone.docs) {
        for (const card of doc.cards) {
            if (card.kind !== 'header') {
                card.content = '';
                // cardType stays 'code' — if we reset to markdown, the
                // GENERATE ALL walkthrough would load the card with codeMode
                // turned OFF (because loadCardForEdit mirrors cardType), and
                // the AI would respond with markdown prose + fences instead
                // of raw Python.
            }
        }
    }
    clone.id = clone.id + '-prompts-only';
    clone.name = clone.name + ' (prompts only)';
    return clone;
}

// Default behaviour: write BOTH variants to disk (matches the calculator
// scaffold). Pass --stdout to keep the legacy stdout-only behaviour.
if (process.argv.includes('--stdout')) {
    process.stdout.write(JSON.stringify(project, null, 2) + '\n');
} else {
    const promptsOnly = blankBodies(project);
    writeFileSync(join(HERE, 'tic_tac_toe.slate.json'), JSON.stringify(project, null, 2) + '\n');
    writeFileSync(join(HERE, 'tic_tac_toe.prompts_only.slate.json'), JSON.stringify(promptsOnly, null, 2) + '\n');
    // Tests live OUTSIDE slate — written once, run with pytest from a terminal
    // against whatever tic_tac_toe.py the slate compile step produces.
    mkdirSync(join(HERE, 'tests'), { recursive: true });
    writeFileSync(join(HERE, 'tests', 'test_units.py'), tests_file_src);
    console.log('Wrote tic_tac_toe.slate.json + tic_tac_toe.prompts_only.slate.json + tests/test_units.py');
}
