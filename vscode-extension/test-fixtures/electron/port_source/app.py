from ops import OPS, add


def run(a: int, b: int) -> int:
    OPS["+"] = add
    return add(a, b)


if __name__ == "__main__":
    print(run(1, 2))
