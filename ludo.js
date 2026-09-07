// Pure Ludo game-logic helpers, kept in their own module (same idea as
// auth.js) so the core movement/capture rules can be unit-tested directly —
// no HTTP server, no real dice rolls needed — before server.js wires them up
// to actual tables, turns, and players.
//
// A piece's position is just a "progress" integer, nothing more:
//   0        = still at base, not yet on the board
//   1 - 51   = out on the shared 52-cell outer track
//   52 - 57  = that color's own private 6-cell home stretch
//   58       = finished (reached the center)
// The client is the only thing that ever turns a (color, progress) pair
// into an actual row/column on the visual board — this module never deals
// in coordinates, only in these abstract numbers.

const LUDO_COLOR_SETS = {
  2: ['red', 'blue'],
  4: ['red', 'green', 'gold', 'blue'],
};

// Each color's entry point onto the shared 52-cell track, spaced evenly
// (52 / 4 = 13 apart) going clockwise: red (top-left) -> green (top-right)
// -> gold (bottom-right) -> blue (bottom-left). A 2-player match uses red
// and blue, which sit in opposite corners of the board.
const LUDO_ENTRY = { red: 0, green: 13, gold: 26, blue: 39 };

// Safe cells: each color's own entry square, plus one "star" square evenly
// between entries (entry + 8) — a piece can never be captured while sitting
// on one of these, matching the classic board's safe-square layout.
const LUDO_SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

const LUDO_FINISH = 58; // progress value once a piece has reached the center

function ludoGlobalIdx(color, progress) {
  return (LUDO_ENTRY[color] + progress - 1 + 52) % 52;
}

// Which of a seat's 4 pieces are legally allowed to move given this roll —
// a piece at base needs a 6 to come out, a finished piece can't move again,
// and a piece can't move past the finish line exactly (must roll the exact
// remaining distance to land on it, same as classic Ludo).
function ludoLegalMoves(pieces, roll) {
  const moves = [];
  pieces.forEach((p, i) => {
    if (p === 0) {
      if (roll === 6) moves.push(i);
      return;
    }
    if (p === LUDO_FINISH) return;
    if (p + roll <= LUDO_FINISH) moves.push(i);
  });
  return moves;
}

// Mutates state.seats[seatIndex].pieces[pieceIndex] in place (and any
// opponent piece it captures along the way), and reports what happened so
// the caller can decide whether the same player goes again.
function ludoApplyMove(state, seatIndex, pieceIndex, roll) {
  const seat = state.seats[seatIndex];
  const before = seat.pieces[pieceIndex];
  const newProgress = before === 0 ? 1 : before + roll;
  seat.pieces[pieceIndex] = newProgress;

  let captured = false;
  // Captures only ever happen out on the shared track, and never on a safe
  // cell — a piece in its own private home stretch can't be touched at all.
  if (newProgress >= 1 && newProgress <= 51) {
    const myGlobal = ludoGlobalIdx(seat.color, newProgress);
    if (!LUDO_SAFE.has(myGlobal)) {
      state.seats.forEach((other, oi) => {
        if (oi === seatIndex) return;
        other.pieces.forEach((op, opi) => {
          if (op >= 1 && op <= 51 && ludoGlobalIdx(other.color, op) === myGlobal) {
            other.pieces[opi] = 0; // sent back to base
            captured = true;
          }
        });
      });
    }
  }

  const finished = newProgress === LUDO_FINISH;
  return { captured, finished };
}

function ludoHasWon(seat) {
  return seat.pieces.every((p) => p === LUDO_FINISH);
}

module.exports = {
  LUDO_COLOR_SETS,
  LUDO_ENTRY,
  LUDO_SAFE,
  LUDO_FINISH,
  ludoGlobalIdx,
  ludoLegalMoves,
  ludoApplyMove,
  ludoHasWon,
};
