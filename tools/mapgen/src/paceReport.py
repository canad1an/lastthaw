"""
Summarise a high-speed test match recorded by apps/server/src/scripts/snapshot.ts.

  python -I tools/mapgen/src/paceReport.py <out.jsonl>

Reads <out>.jsonl (periodic snapshots) and <out>.final.json (events, jobs,
players) and prints: when each age was reached per AI tier, score and
territory curves, actions per player per day, build/research durations by
age, queue idleness and stockpiles against storage. Everything is in game
days and game hours, independent of the match speed.
"""
import json
import statistics as st
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

src = sys.argv[1]
snaps = [json.loads(l) for l in open(src, encoding="utf-8") if l.strip()]
fin = json.load(open(src.replace(".jsonl", "") + ".final.json", encoding="utf-8"))
m = fin["match"]
speed = m["speed"]
starts = datetime.fromisoformat(m["startsAt"].replace("Z", "+00:00"))
players = {p["id"]: p for p in fin["players"]}


def day_of(iso):
    t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (t - starts).total_seconds() / 86400 * speed


def tier(p):
    return (p.get("aiProfile") or "human").split(":")[0]


def med(xs):
    return round(st.median(xs), 1) if xs else None


print(f"# {m['name']}  speed {speed}x  status {m['status']}  players {len(players)}  snapshots {len(snaps)}")
last = snaps[-1]
print(f"last snapshot day {last['day']}")

# ---- ages ------------------------------------------------------------------
print("\n## Day each age was reached (median per tier; n = players that got there)")
reached = defaultdict(lambda: defaultdict(list))  # tier -> age -> [day]
for e in fin["events"]:
    if e["kind"] == "age.advanced":
        p = players.get(e["payload"]["playerId"])
        if p:
            reached[tier(p)][e["payload"]["age"]].append(day_of(e["at"]))
tiers = ["easy", "medium", "hard", "human"]
print("tier    " + "".join(f"age{a:<12}" for a in range(1, 5)))
for t in tiers:
    row = []
    for a in range(1, 5):
        xs = reached[t].get(a, [])
        row.append(f"{med(xs)} (n={len(xs)})".ljust(15) if xs else "-".ljust(15))
    print(f"{t:<8}" + "".join(row))

# ---- score / territory curves ---------------------------------------------
print("\n## Score, regions, population, building levels by day (median of all AI)")
print("day   score  regions  pop   bldgLv  frozenRegions  eliminated")
for s in snaps:
    if s["day"] % 3 < (snaps[1]["day"] - snaps[0]["day"]) if len(snaps) > 1 else True:
        ai = [p for p in s["players"] if p["ai"]]
        print(
            f"{s['day']:<5.1f} {med([p['score'] for p in ai]):<6} {med([p['regions'] for p in ai]):<8} {med([p['pop'] for p in ai]):<5} "
            f"{med([p['buildingLevels'] for p in ai]):<7} {sum(p['frozen'] for p in ai):<14} {sum(p['eliminated'] for p in ai)}"
        )

# ---- final standings ---------------------------------------------------------
print("\n## Final standings")
for p in sorted(last["players"], key=lambda p: -p["score"]):
    print(f"{p['score']:>6}  age{p['age']}  regions {p['regions']:>2} ({p['frozen']} frozen)  pop {p['pop']:>5}  {p['name']} [{p['ai'] or 'human'}]{' ELIMINATED' if p['eliminated'] else ''}")

# ---- actions per day ------------------------------------------------------------
jobs = fin["jobs"]
print("\n## Completed build/research/train jobs per AI player per game day")
per_day = Counter()
for j in jobs:
    if j["completedAt"] and j["playerId"] and players[j["playerId"]]["isAi"]:
        per_day[int(day_of(j["endsAt"]))] += 1
n_ai = sum(1 for p in players.values() if p["isAi"])
print(" ".join(f"d{d}:{per_day[d] / n_ai:.1f}" for d in range(0, 31)))

# ---- durations ------------------------------------------------------------------
print("\n## Job durations in game hours, by kind and the day they were queued (median / max)")
by = defaultdict(list)
for j in jobs:
    d = int(day_of(j["startsAt"]))
    hours = (datetime.fromisoformat(j["endsAt"].replace("Z", "+00:00")) - datetime.fromisoformat(j["startsAt"].replace("Z", "+00:00"))).total_seconds() / 3600 * speed
    by[(j["kind"], min(30, d // 5 * 5))].append(hours)
for kind in ["build", "research", "train"]:
    print(kind + ": " + "  ".join(f"d{d}-{d + 4}: {med(by[(kind, d)])}h/{round(max(by[(kind, d)]), 1)}h" for d in range(0, 30, 5) if by[(kind, d)]))

print("\n## Highest building level reached per building (any player)")
top = {}
for j in jobs:
    if j["kind"] == "build" and j["completedAt"]:
        top[j["refId"]] = max(top.get(j["refId"], 0), j["level"] or 0)
print(", ".join(f"{k} L{v}" for k, v in sorted(top.items(), key=lambda x: -x[1])))

# ---- idleness and stockpiles ----------------------------------------------------
print("\n## Queue idleness: share of AI snapshots with no build job pending, by 5-day window")
idle = defaultdict(lambda: [0, 0])
for s in snaps:
    w = min(25, int(s["day"]) // 5 * 5)
    for p in s["players"]:
        if p["ai"] and not p["eliminated"]:
            idle[w][1] += 1
            if not p["queues"].get("build"):
                idle[w][0] += 1
print("  ".join(f"d{w}-{w + 4}: {100 * a / b:.0f}%" for w, (a, b) in sorted(idle.items()) if b))

print("\n## Median AI stockpile (food/wood/stone) at days 1, 5, 10, 20, 29")
for target in [1, 5, 10, 20, 29]:
    s = min(snaps, key=lambda s: abs(s["day"] - target))
    ai = [p for p in s["players"] if p["ai"]]
    print(f"day {s['day']:<5.1f} food {med([p['food'] for p in ai])}  wood {med([p['wood'] for p in ai])}  stone {med([p['stone'] for p in ai])}")

# ---- events ---------------------------------------------------------------------
print("\n## Event counts")
kinds = Counter(e["kind"] for e in fin["events"])
print(", ".join(f"{k}: {n}" for k, n in kinds.most_common()))
print(f"battles: {fin['battles']}")
