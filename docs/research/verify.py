#!/usr/bin/env python3
"""Verify candidate sources against Crossref: DOI, venue, type, year, first author.

  python3 -I verify.py candidates.tsv refs.json

A source is accepted only if Crossref returns a journal article, proceedings paper or book chapter whose title
matches the query closely and whose author list contains the expected surname. The venue is recorded so the
peer-review status can be checked; preprint servers (arXiv, ePrint, SSRN) are rejected.
"""
import json, re, sys, time, unicodedata, urllib.parse, urllib.request
from difflib import SequenceMatcher

PEER_TYPES = {"journal-article", "proceedings-article", "book-chapter"}
PREPRINT = re.compile(r"arxiv|eprint|ssrn|preprint|research square|techrxiv", re.I)

def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]+", " ", s).split()

def sim(a, b):
    a, b = " ".join(norm(a)), " ".join(norm(b))
    return SequenceMatcher(None, a, b).ratio()

def query(title, author):
    q = urllib.parse.urlencode({"query.bibliographic": title, "query.author": author, "rows": 8,
                                "select": "DOI,title,subtitle,container-title,type,issued,author,abstract,publisher"})
    for i in range(4):
        try:
            with urllib.request.urlopen("https://api.crossref.org/works?" + q, timeout=30) as r:
                return json.load(r)["message"]["items"]
        except Exception as e:
            time.sleep(3 * (i + 1)); err = e
    raise err

def main(src, out):
    refs = []
    for line in open(src):
        if line.startswith("#") or not line.strip():
            continue
        rid, topic, author, title = line.rstrip("\n").split("\t")
        best = None
        for it in query(title, author):
            t = " ".join(it.get("title", [""]) + it.get("subtitle", []))
            s = max(sim(title, t), sim(title, (it.get("title") or [""])[0]))
            surnames = [" ".join(norm(a.get("family", ""))) for a in it.get("author", [])]
            amatch = any(" ".join(norm(author)).split()[-1] in s_ for s_ in surnames)
            venue = (it.get("container-title") or [""])[0]
            ok = it.get("type") in PEER_TYPES and not PREPRINT.search(venue + " " + it.get("publisher", "")) and amatch
            score = s + (0.5 if ok else 0)
            if best is None or score > best[0]:
                best = (score, s, ok, it, venue)
        rec = {"id": rid, "topic": topic, "query": title}
        if best and best[2] and best[1] >= 0.72:
            it = best[3]
            rec.update(status="verified", doi=it["DOI"], title=" ".join(it.get("title", [""])), venue=best[4],
                       type=it["type"], year=(it.get("issued", {}).get("date-parts") or [[None]])[0][0],
                       authors=[f'{a.get("given","")} {a.get("family","")}'.strip() for a in it.get("author", [])],
                       publisher=it.get("publisher"), has_abstract=bool(it.get("abstract")), match=round(best[1], 2))
        else:
            rec.update(status="not-verified", best=(best and {"title": (best[3].get("title") or [""])[0], "venue": best[4],
                       "type": best[3].get("type"), "doi": best[3].get("DOI"), "match": round(best[1], 2)}))
        refs.append(rec)
        print(f'{rec["status"]:13} {rid:20} {rec.get("venue") or (rec.get("best") or {}).get("venue","")}'[:150], flush=True)
        time.sleep(0.4)
    json.dump(refs, open(out, "w"), indent=1, ensure_ascii=False)
    print(sum(r["status"] == "verified" for r in refs), "verified of", len(refs))

main(*sys.argv[1:3])
