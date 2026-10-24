#!/usr/bin/env python3
"""Merge the Crossref-verified batches, apply manual corrections, write bibliography.json."""
import json
r1, r2 = json.load(open("refs.json")), json.load(open("refs2.json"))
DROP = {"puddu20", "ngo-blockchain-trust", "vrf", "txfee-dag", "halving", "supply-schedule", "romiti19", "ethereclipse"}
FIX = {  # originals found by DOI (Crossref /works/<doi>)
 "jensen76": ("10.1016/0304-405X(76)90026-X", "Theory of the firm: Managerial behavior, agency costs and ownership structure", "Journal of Financial Economics", 1976, ["Michael C. Jensen", "William H. Meckling"], "journal-article"),
 "fama83": ("10.1086/467037", "Separation of Ownership and Control", "The Journal of Law and Economics", 1983, ["Eugene F. Fama", "Michael C. Jensen"], "journal-article"),
 "ostrom00": ("10.1257/jep.14.3.137", "Collective Action and the Evolution of Social Norms", "Journal of Economic Perspectives", 2000, ["Elinor Ostrom"], "journal-article"),
 "pbft99": ("10.1145/571637.571640", "Practical Byzantine fault tolerance and proactive recovery", "ACM Transactions on Computer Systems", 2002, ["Miguel Castro", "Barbara Liskov"], "journal-article"),
 "noda20": ("10.1111/iere.70028", "An Economic Analysis of Difficulty Adjustment Algorithms in Proof-of-Work Blockchain Systems", "International Economic Review", 2025, ["Shunya Noda", "Kyohei Okumura", "Yoshinori Hashimoto"], "journal-article"),
 "budish": ("10.1145/3670865.3673548", "The Economic Limits of Permissionless Consensus", "Proceedings of the 25th ACM Conference on Economics and Computation (EC '24)", 2024, ["Eric Budish", "Andrew Lewis-Pye", "Tim Roughgarden"], "proceedings-article"),
 "bridgesok": ("10.1145/3678890.3678894", "Security of Cross-chain Bridges: Attack Surfaces, Defenses, and Open Problems", "RAID 2024", 2024, ["Mengya Zhang", "Xiaokuan Zhang", "Yinqian Zhang", "Zhiqiang Lin"], "proceedings-article"),
 "flyclient20": ("10.1109/SP40000.2020.00049", "FlyClient: Super-Light Clients for Cryptocurrencies", "2020 IEEE Symposium on Security and Privacy (SP)", 2020, ["Benedikt Bünz", "Lucianna Kiffer", "Loi Luu", "Mahdi Zamani"], "proceedings-article"),
}
USENIX = {  # peer-reviewed USENIX proceedings without DOIs; checked on usenix.org
 "conflux20": ("A Decentralized Blockchain with High Throughput and Fast Confirmation", "USENIX ATC 2020", 2020, ["Chenxing Li", "Peilun Li", "Dong Zhou", "Zhe Yang", "Ming Wu", "Guang Yang", "Wei Xu", "Fan Long", "Andrew Chi-Chih Yao"], "https://www.usenix.org/conference/atc20/presentation/li-chenxing"),
 "bitcoinng16": ("Bitcoin-NG: A Scalable Blockchain Protocol", "USENIX NSDI 2016", 2016, ["Ittay Eyal", "Adem Efe Gencer", "Emin Gün Sirer", "Robbert van Renesse"], "https://www.usenix.org/conference/nsdi16/technical-sessions/presentation/eyal"),
 "eclipse15": ("Eclipse Attacks on Bitcoin's Peer-to-Peer Network", "USENIX Security 2015", 2015, ["Ethan Heilman", "Alison Kendler", "Aviv Zohar", "Sharon Goldberg"], "https://www.usenix.org/conference/usenixsecurity15/technical-sessions/presentation/heilman"),
 "byzcoin16": ("Enhancing Bitcoin Security and Performance with Strong Consistency via Collective Signing", "USENIX Security 2016", 2016, ["Eleftherios Kokoris-Kogias", "Philipp Jovanovic", "Nicolas Gailly", "Ismail Khoffi", "Linus Gasser", "Bryan Ford"], "https://www.usenix.org/conference/usenixsecurity16/technical-sessions/presentation/kogias"),
 "mai20": ("User Mental Models of Cryptocurrency Systems - A Grounded Theory Approach", "SOUPS 2020 (USENIX)", 2020, ["Alexandra Mai", "Katharina Pfeffer", "Matthias Gusenbauer", "Edgar Weippl", "Katharina Krombholz"], "https://www.usenix.org/conference/soups2020/presentation/mai"),
 "perez21": ("Smart Contract Vulnerabilities: Vulnerable Does Not Imply Exploited", "USENIX Security 2021", 2021, ["Daniel Perez", "Benjamin Livshits"], "https://www.usenix.org/conference/usenixsecurity21/presentation/perez"),
}
QUAL = {"mai20", "krombholz16", "eskandari15", "voskobojnikov21", "sharma24", "ziolkowski20", "sas18", "elsden18", "khairuddin16",
        "froehlich21", "ebrahim03", "lister03", "ngo-legitimacy", "ngo-accountability", "ngo-certification", "zwitter18", "defilippi16",
        "reijers16", "rikken19", "beck18", "hassan21", "kshetri17", "bekkers03", "gugerty09", "vanpelt21", "liu23", "chen-dao"}
out = []
for r in r1 + r2:
    rid = r["id"]
    if rid in DROP: continue
    if rid in FIX:
        d, t, v, y, a, ty = FIX[rid]
        r = {"id": rid, "topic": r["topic"], "status": "verified", "doi": d, "title": t, "venue": v, "year": y, "authors": a, "type": ty}
    elif rid in USENIX:
        t, v, y, a, u = USENIX[rid]
        r = {"id": rid, "topic": r["topic"], "status": "verified", "doi": None, "url": u, "title": t, "venue": v, "year": y, "authors": a, "type": "proceedings-article"}
    elif r["status"] != "verified":
        continue
    r.pop("query", None); r.pop("match", None)
    r["kind"] = "qualitative" if rid in QUAL else "quantitative/technical"
    r.setdefault("read", "not yet")
    out.append(r)
json.dump(out, open("bibliography.json", "w"), indent=1, ensure_ascii=False)
print(len(out), "verified peer-reviewed sources;", sum(r["kind"] == "qualitative" for r in out), "qualitative")
