## @slate v=2 id=greet-unit
## intent: Return a visible greeting
## contract: Preserve the caller's name
## locked: false
## @slate-end
def greet(name: str) -> str:
    return name.upper()
