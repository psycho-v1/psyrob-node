#!/usr/bin/env python3
"""Build RESEARCH.md = RESEARCH_HEAD.md + bibliography table; fail on citations missing from the bibliography."""
import json, re, sys
head = open("RESEARCH_HEAD.md").read()
bib = {r["id"]: r for r in json.load(open("bibliography.json"))}
spec = open("../dag/DAG_SPEC.md").read() + open("../SECURITY.md").read() + open("../RISK_REVIEW.md").read() + open("../DECISIONS.md").read()
missing = sorted({c for c in re.findall(r"\[([a-z0-9-]+)\]", head + spec) if c not in bib})
if missing: sys.exit("citations not in bibliography: " + ", ".join(missing))
rows = ["| Id | Authors | Year | Title | Venue | DOI / URL | Kind | Read |", "|---|---|---|---|---|---|---|---|"]
for r in sorted(bib.values(), key=lambda r: (r["topic"], r["id"])):
    au = r["authors"][0] + (" et al." if len(r["authors"]) > 1 else "") if r["authors"] else ""
    link = f'https://doi.org/{r["doi"]}' if r.get("doi") else r.get("url", "")
    t = r["title"].replace("|", "/")
    rows.append(f'| {r["id"]} | {au} | {r["year"]} | {t} | {r["venue"]} | {link} | {r["kind"]} | {r["read"]} |')
open("RESEARCH.md", "w").write(head + "\n".join(rows) + "\n")
print(len(bib), "sources; all citations resolve")
