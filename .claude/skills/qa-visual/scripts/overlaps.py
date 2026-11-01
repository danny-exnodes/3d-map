"""Counts overlapping building footprints in a __city.data dump (shoot.cjs DUMP=...).
Usage: python3 overlaps.py dump.json [min_share=0.2]   (pip install shapely)"""
import json, math, sys
from collections import Counter
from shapely.geometry import Polygon
from shapely.strtree import STRtree

d = json.load(open(sys.argv[1])); share = float(sys.argv[2]) if len(sys.argv) > 2 else 0.2
b = d['buildings']; lat0 = (d['bbox']['south'] + d['bbox']['north']) / 2; lon0 = (d['bbox']['west'] + d['bbox']['east']) / 2
k = 111320; c = math.cos(math.radians(lat0))
P = [Polygon([((x - lon0) * k * c, (y - lat0) * k) for x, y in q['polygon'][0]]).buffer(0) for q in b]
t = STRtree(P); bad = []
for i, p in enumerate(P):
    for j in t.query(p):
        if j > i and p.intersection(P[j]).area > share * min(p.area, P[j].area):
            bad.append((b[i]['footprintSource'], b[j]['footprintSource']))
print('buildings', len(b), 'footprint area m2', round(sum(p.area for p in P)))
print('overlapping pairs >', share, ':', len(bad)); print(Counter(bad).most_common())
