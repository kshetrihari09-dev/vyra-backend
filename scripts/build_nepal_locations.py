#!/usr/bin/env python3
"""
Rebuilds Nepal's location data from the municipality boundary file of
  https://github.com/younginnovations/nepal-locallevel-map   (MIT)   out/municipalities.simplified.geojson
Outputs:
  frontend/src/data/nepalLocations.json   province > district > municipality (+ ward count) for the address form dropdowns
  backend/src/data/nepalLocalLevels.json  compact boundaries for "which municipality is this pin in?" (services/geo.service.js)
Existing ids (e.g. "butwal-sub") are kept wherever a municipality already existed, so saved addresses keep working.
Usage: python3 backend/scripts/build_nepal_locations.py <municipalities.simplified.geojson> <old-locations.json>
  (old-locations.json = {"P":PROVINCES,"D":DISTRICTS,"M":MUNICIPALITIES} dumped from the previous frontend/src/data/locations.js)
"""
import json, os, re, sys
geo, oldp = sys.argv[1], sys.argv[2]
old = json.load(open(oldp)); d = json.load(open(geo))
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PROV = ['koshi', 'madhesh', 'bagmati', 'gandaki', 'lumbini', 'karnali', 'sudurpashchim']
TYPE = {'Mahanagarpalika': ('Metropolitan City', 'metro'), 'Upamahanagarpalika': ('Sub-Metropolitan City', 'sub'), 'Nagarpalika': ('Municipality', 'mun'), 'Gaunpalika': ('Rural Municipality', 'rural')}
slug = lambda s: re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')
norm = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())
DIST_ALIAS = {'Chitawan': 'chitwan', 'Kapilbastu': 'kapilvastu', 'Tanahu': 'tanahun'}
NAME_ALIAS = {'kapilbastu': 'kapilvastu', 'pokharalekhnath': 'pokhara', 'budhanilakantha': 'budhanilkantha'}  # source spelling -> legacy spelling
dname = lambda raw: re.sub(r'_E$', ' East', re.sub(r'_W$', ' West', raw)).replace('_', ' ')
did_of = lambda raw: DIST_ALIAS.get(raw) or slug(dname(raw))
old_dist_name = {x['id']: x['name'] for ds in old['D'].values() for x in ds}

districts = {}
for f in d['features']:
    p = f['properties']; did = did_of(p['district'])
    districts.setdefault(did, {'id': did, 'name': old_dist_name.get(did, dname(p['district'])), 'province': PROV[p['province'] - 1]})
assert len(districts) == 77, len(districts)

STRIP = re.compile(r'(sub-?metropolitan city|metropolitan city|rural municipality|municipality)$', re.I)
legacy = {(did, norm(STRIP.sub('', m['name']).strip())): m for did, ms in old['M'].items() for m in ms}
used, by_name, munis, areas = set(), {}, [], []
unmatched = {(did, m['id']) for did, ms in old['M'].items() for m in ms}
for f in d['features']:
    p = f['properties']; t = p['locallevel_type']; did = did_of(p['district'])
    if t not in TYPE: areas.append(f); continue
    label, suf = TYPE[t]; name = p['locallevel_name']; key = (did, norm(name))
    twin = key in by_name                      # e.g. Bansagadhi is one municipality drawn as two polygons
    if twin: mid, display = by_name[key]
    else:
        hit = legacy.get((did, NAME_ALIAS.get(norm(name), norm(name))))
        if hit: mid, display = hit['id'], hit['name']; unmatched.discard((did, mid))
        else:
            mid, display = f"{slug(name)}-{suf}", f"{name} {label}"
            if mid in used: mid = f"{mid}-{did}"
        assert mid not in used, mid
        used.add(mid); by_name[key] = (mid, display)
    w = p.get('wards')
    munis.append({'id': mid, 'name': display, 'district': did, 'wards': int(w) if w else None, 'feat': f, 'twin': twin})
listed = [m for m in munis if not m['twin']]
print('local levels', len(listed), '| ward count unknown for', sum(1 for m in listed if m['wards'] is None), '| legacy ids not matched:', sorted(unmatched))

prov_names = {x['id']: x['name'] for x in old['P']}
out = {'provinces': [{'id': i, 'name': prov_names[i]} for i in PROV], 'districts': {}, 'municipalities': {}}
for did, x in sorted(districts.items(), key=lambda kv: kv[1]['name']): out['districts'].setdefault(x['province'], []).append({'id': did, 'name': x['name']})
for m in sorted(listed, key=lambda m: m['name']): out['municipalities'].setdefault(m['district'], []).append({'id': m['id'], 'name': m['name'], 'wards': m['wards']})
json.dump(out, open(f'{ROOT}/frontend/src/data/nepalLocations.json', 'w'), ensure_ascii=False, separators=(',', ':'))

def rings_of(g):
    polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
    return [[[round(v, 5) for pt in ring for v in pt] for ring in poly] for poly in polys]
def bbox(polys):
    xs = [r[i] for poly in polys for r in poly[:1] for i in range(0, len(r), 2)]; ys = [r[i] for poly in polys for r in poly[:1] for i in range(1, len(r), 2)]
    return [min(xs), min(ys), max(xs), max(ys)]
feats = []
for m in munis:
    polys = rings_of(m['feat']['geometry']); feats.append({'m': m['id'], 'd': m['district'], 'b': bbox(polys), 'p': polys})
for f in areas:
    p = f['properties']; polys = rings_of(f['geometry']); feats.append({'a': p['locallevel_name'], 't': p['locallevel_type'], 'd': did_of(p['district']), 'b': bbox(polys), 'p': polys})
os.makedirs(f'{ROOT}/backend/src/data', exist_ok=True)
meta = {'prov': {x['id']: x['name'] for x in out['provinces']}, 'dist': {i: {'n': x['name'], 'p': x['province']} for i, x in districts.items()}, 'muni': {m['id']: {'n': m['name'], 'w': m['wards']} for m in listed}}
json.dump({'source': 'younginnovations/nepal-locallevel-map (MIT), simplified', 'meta': meta, 'features': feats}, open(f'{ROOT}/backend/src/data/nepalLocalLevels.json', 'w'), separators=(',', ':'))
print('wrote frontend/src/data/nepalLocations.json and backend/src/data/nepalLocalLevels.json')
