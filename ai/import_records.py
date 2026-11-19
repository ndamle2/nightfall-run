"""Imports game records collected by the site's Google Sheet (tools/sheets/) into
data/games/, checking every one against the rules first:

    python3 -m ai.import_records games.csv [more.csv ...] [--out data/games]

games.csv: the sheet downloaded with File > Download > Comma-separated values. Each row's
last column is one record (the page's format, see ai/human_games.py). Rows that are not
legal games on the current maps are skipped and counted; a game sent more than once keeps
its longest copy, and an existing file is only replaced by a longer one.
"""
import argparse
import csv
import json
import re
import sys
from pathlib import Path

from . import human_games as H

csv.field_size_limit(10 ** 7)
ID_RE = re.compile(r'^[A-Za-z0-9_-]{6,64}$')


def read_rows(paths):
    for p in paths:
        with open(p, newline='', encoding='utf-8') as f:
            for row in csv.reader(f):
                if row and row[-1].lstrip().startswith('{'):
                    yield row[-1]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('csv', nargs='+')
    ap.add_argument('--out', default=str(H.DEFAULT_DIR))
    a = ap.parse_args(argv)
    out = Path(a.out)
    best, bad = {}, {}
    for text in read_rows(a.csv):
        try:
            rec = json.loads(text)
            if not ID_RE.match(str(rec.get('id', ''))):
                raise ValueError('bad id')
            H.replay(rec)
        except Exception as e:  # noqa: BLE001 - any malformed row is skipped
            reason = str(e).split(':')[0][:60] or type(e).__name__
            bad[reason] = bad.get(reason, 0) + 1
            continue
        old = best.get(rec['id'])
        if old is None or len(rec['history']) > len(old['history']) or (
                len(rec['history']) == len(old['history']) and rec.get('result') and not old.get('result')):
            best[rec['id']] = rec
    out.mkdir(parents=True, exist_ok=True)
    new = updated = same = 0
    for gid, rec in best.items():
        path = out / f'{gid}.json'
        if path.exists():
            old = json.loads(path.read_text())
            if len(old.get('history', [])) >= len(rec['history']):
                same += 1
                continue
            updated += 1
        else:
            new += 1
        path.write_text(json.dumps(rec, indent=1))
    print(f'{len(best)} games read: {new} new, {updated} updated, {same} already here')
    if bad:
        print('skipped: ' + ', '.join(f'{n} ({why})' for why, n in sorted(bad.items(), key=lambda x: -x[1])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
