"""把 Penna 的词库和 danbooru-zh-dict 合成一份，生成 data/tags.tsv.gz 和 data/characters.tsv.gz。

    python tools/merge_dict.py <danbooru_zh_dict.csv> <Penna 的 danbooru_tags.tsv.gz> <Penna 的 danbooru_characters.tsv.gz>

两边各取所长：
- danbooru-zh-dict（wangjue520/danbooru-zh-dict）：12.6 万个图数 ≥50 的标签，每个都有中文名、中文同义词、
  英文别名（含 Danbooru 改名前的旧名）、日文别名和一句说明，图数是 2026-10 的。
- Penna（storyAura/Penna）：多出约 1 万个图数 20~49 的冷门标签和 Pixiv 上的叫法；
  角色库 6.9 万个角色，每个都分好了「外貌」和「服装」特征词。

输出（UTF-8，制表符分隔，多个值用 | 隔开）：
  tags.tsv.gz        标签 分类 图数 中文名 中文同义词 英文别名 其他别名 说明
  characters.tsv.gz  角色名 作品 外貌 服装 别名 中文名 中文同义词 图数 说明
分类：0 通用 1 画师 3 作品 4 角色 5 元标签。两份都按图数从多到少排好。
"""

import csv
import gzip
import os
import re
import sys

CATEGORY = {"通用": 0, "画师": 1, "作品": 3, "角色": 4, "元标签": 5}
HAN = re.compile(r"[一-鿿]")
KANA = re.compile(r"[぀-ヿ가-힯]")  # 假名、韩文
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def split(s, sep="|"):
    return [x.strip() for x in s.split(sep) if x.strip()]


def clean(s):
    return s.replace("\t", " ").replace("\n", " ").replace("|", "/").strip()


def uniq(items, drop=()):
    seen = {d.lower() for d in drop}
    out = []
    for x in items:
        k = x.lower()
        if x and k not in seen:
            seen.add(k)
            out.append(x)
    return out


def chinese_like(s):
    return bool(HAN.search(s)) and not KANA.search(s)


def main(zh_csv, penna_tags, penna_chars):
    # ---------- danbooru-zh-dict ----------
    zh = {}
    alias_of = {}  # 旧名 / 英文别名 -> 现在的标签
    with open(zh_csv, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            tag = r["标签"]
            zh[tag] = {
                "cat": CATEGORY.get(r["分类"], 0),
                "count": int(r["图数"] or 0),
                "zh": r["中文名"].strip(),
                "syn": split(r["中文同义词"]),
                "en": split(r["英文别名"]),
                "other": split(r["日文/其他别名"]),
                "note": r["说明"].strip(),
            }
            for a in zh[tag]["en"]:
                alias_of.setdefault(a, tag)

    # ---------- Penna ----------
    p_tags = {}
    with gzip.open(penna_tags, "rt", encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            p_tags[p[0]] = (int(p[1]) if len(p) > 1 and p[1].isdigit() else 0,
                            split(p[2], ",") if len(p) > 2 else [])
    p_chars = []
    with gzip.open(penna_chars, "rt", encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            p += [""] * (5 - len(p))
            p_chars.append({"name": p[0], "series": p[1], "looks": p[2], "outfit": p[3], "alias": split(p[4], ",")})
    p_char_tags = {c["name"].replace(" ", "_") for c in p_chars}

    # ---------- 标签 ----------
    rows = []
    for tag, z in zh.items():
        extra = p_tags.get(tag, (0, []))[1]
        other = uniq(z["other"] + extra, drop=[z["zh"], *z["syn"], *z["en"], tag])
        rows.append((tag, z["cat"], max(z["count"], p_tags.get(tag, (0,))[0]), z["zh"], z["syn"], z["en"], other, z["note"]))
    added_tags = 0
    for tag, (count, aliases) in p_tags.items():
        if tag in zh or tag in alias_of:
            continue
        cn = uniq([a for a in aliases if chinese_like(a)])
        rows.append((tag, 4 if tag in p_char_tags else 0, count, cn[0] if cn else "", cn[1:], [],
                     uniq([a for a in aliases if a not in cn]), ""))
        added_tags += 1
    rows.sort(key=lambda r: -r[2])
    with gzip.open(os.path.join(OUT_DIR, "tags.tsv.gz"), "wt", encoding="utf-8", compresslevel=9) as f:
        for tag, cat, count, name, syn, en, other, note in rows:
            f.write("\t".join([tag, str(cat), str(count), clean(name), "|".join(map(clean, syn)),
                               "|".join(map(clean, en)), "|".join(map(clean, other)), clean(note)]) + "\n")

    # ---------- 角色 ----------
    chars = {}  # 现在的标签 -> 角色
    renamed = 0
    for c in p_chars:
        old = c["name"].replace(" ", "_")
        tag = old if old in zh else alias_of.get(old, old)
        if tag != old:
            renamed += 1
        z = zh.get(tag)
        if tag in chars:  # 旧名和新名在 Penna 里各有一行：并成一个，特征词留先来的（图多的），先来的没有就用这一行的
            have = chars[tag]
            have["alias"] = uniq(have["alias"] + c["alias"] + ([old.replace("_", " ")] if tag != old else []))
            if not have["looks"] and not have["outfit"]:
                have.update(looks=c["looks"], outfit=c["outfit"], series=have["series"] or c["series"])
            continue
        chars[tag] = {
            "series": c["series"], "looks": c["looks"], "outfit": c["outfit"],
            "alias": uniq(c["alias"] + ([old.replace("_", " ")] if tag != old else []) + (z["other"] if z else [])),
            "zh": z["zh"] if z else "", "syn": z["syn"] if z else [],
            "count": z["count"] if z else p_tags.get(old, (0,))[0],
            "note": z["note"] if z else "",
        }
    copyrights = {t for t, z in zh.items() if z["cat"] == 3}
    added_chars = 0
    for tag, z in zh.items():
        if z["cat"] != 4 or tag in chars:
            continue
        # 作品从名字的括号里猜：furina_(genshin_impact) -> genshin_impact
        m = re.search(r"_\(([^()]+)\)$", tag)
        series = m.group(1) if m and m.group(1) in copyrights else ""
        chars[tag] = {"series": series.replace("_", " "), "looks": "", "outfit": "",
                      "alias": z["other"], "zh": z["zh"], "syn": z["syn"], "count": z["count"], "note": z["note"]}
        added_chars += 1
    with gzip.open(os.path.join(OUT_DIR, "characters.tsv.gz"), "wt", encoding="utf-8", compresslevel=9) as f:
        for tag, c in sorted(chars.items(), key=lambda kv: -kv[1]["count"]):
            f.write("\t".join([tag.replace("_", " "), clean(c["series"]), clean(c["looks"]), clean(c["outfit"]),
                               "|".join(map(clean, c["alias"])), clean(c["zh"]), "|".join(map(clean, c["syn"])),
                               str(c["count"]), clean(c["note"])]) + "\n")

    print(f"标签 {len(rows)} 个（danbooru-zh-dict {len(zh)}，Penna 补了 {added_tags}）")
    print(f"角色 {len(chars)} 个（Penna {len(p_chars)}，其中 {renamed} 个旧名换成现在的名字；"
          f"danbooru-zh-dict 补了 {added_chars} 个）")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
