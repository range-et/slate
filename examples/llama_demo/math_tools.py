## @slate v=2 id=demo-clamp
## intent: Clamp an integer to the inclusive lower and upper bounds
## contract: Raise ValueError when lower is greater than upper
## locked: true
## @slate-end
def clamp(value: int, lower: int, upper: int) -> int:
    if lower > upper:
        raise ValueError("lower must not exceed upper")
    return max(lower, min(value, upper))


## @slate v=2 id=demo-normalize-score
## intent: Convert a score to an integer percentage from 0 through 100
## contract: Use clamp as reference behavior; raise ValueError when maximum is not positive
## depends-on: demo-clamp
## locked: false
## @slate-end
def normalize_score(score: int, maximum: int) -> int:
    raise NotImplementedError("Slate demo target")
