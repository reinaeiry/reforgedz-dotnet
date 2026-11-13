"""Builds the map layers the icon extract (map-data.js pois) has no source for: the loot tier zones, every spot
the moving black market can open at, the bunkers and the airfields. Reads the ReforgedZ Dev Chernarus layers and
writes public/map/map-layers.js plus the bunker / airfield icons (drawn in the in-game badge style).

Usage: py tools/map/build_layers.py "<addons folder>"      (the folder that holds "ReforgedZ Dev")

Never shown: missions, quests, keys / keycards, anti-cheat zones.
"""
import glob
import json
import os
import re
import sys
from datetime import date

from PIL import Image, ImageDraw

LAYERS = os.path.join(sys.argv[1], 'ReforgedZ Dev', 'Worlds', 'Chernarus', 'ChernarusReforgedZ_Layers')
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'map')
AIRFIELDS = [('Northwest Airfield', 4674, 10083), ('Northeast Airfield', 12043, 12684), ('Balota Airstrip', 4875, 2350)]
HEADER = re.compile(r'^(\$grp\s+)?(?:(\w+)\s+)?(\w+)(?:\s+(\w+))?\s*(?::\s*"([^"]*)")?\s*\{$')


class Node:
    def __init__(self, cls, ref):
        self.cls, self.ref = cls, ref
        self.attrs = {}
        self.blocks = []
        self.points = []

    def coords(self):
        v = self.attrs.get('coords')
        return tuple(float(a) for a in v.split()[:3]) if v else None


def parse(path):
    """Enfusion layer text -> tree of entities ($grp instances expanded, polyline points kept)."""
    lines = [l.strip() for l in open(path, encoding='utf-8', errors='replace')]
    pos = 0

    def block(node, group=False):
        nonlocal pos
        while pos < len(lines):
            line = lines[pos]
            pos += 1
            if line == '}':
                return node
            if group and line == '{':
                node.blocks.append(block(Node('', None)))
                continue
            if line.endswith('{'):
                if line == 'Points {':
                    child = block(Node('Points', None))
                    node.points = [tuple(float(a) for a in b.attrs['Position'].split()[:3])
                                   for b in child.blocks if 'Position' in b.attrs]
                    continue
                comp = re.match(r'^(\w+)\s+"[^"]*"\s*\{$', line)
                if comp:
                    node.blocks.append(block(Node(comp.group(1), None)))
                    continue
                m = HEADER.match(line)
                if line == '{' or not m:
                    child = block(Node('', None))
                    node.blocks.extend(child.blocks if line == '{' else [child])
                    continue
                grp, a, b, c, ref = m.groups()
                cls = c or b or a
                if grp:
                    for inst in block(Node('', None), group=True).blocks:
                        inst.cls, inst.ref = cls, ref
                        node.blocks.append(inst)
                    continue
                node.blocks.append(block(Node(cls, ref)))
                continue
            parts = line.split(None, 1)
            if len(parts) == 2:
                node.attrs[parts[0]] = parts[1]
        return node

    return block(Node('ROOT', None))


def tier_zones():
    zones = []
    for path in sorted(glob.glob(os.path.join(LAYERS, 'Tiers', '*.layer'))):
        for shape in parse(path).blocks:
            ox, _, oz = shape.coords() or (0, 0, 0)
            tier = next((b.attrs['m_TierFlags'] for b in shape.blocks if 'm_TierFlags' in b.attrs), None)
            if tier and len(shape.points) >= 3:
                zones.append({'tier': int(re.sub(r'\D', '', tier) or 1),
                              'points': [[round(ox + p[0]), round(oz + p[2])] for p in shape.points]})
    return zones


def black_market():
    spots = []
    for path in glob.glob(os.path.join(LAYERS, 'Blackmarket', '*.layer')):
        for site in parse(path).blocks:
            if 'RZ_BlackMarketSite' in (site.ref or '') and site.coords():
                x, _, z = site.coords()
                spots.append({'name': 'Black Market (possible spot)', 'icon': 'blackmarket', 'x': round(x), 'z': round(z)})
    return spots


def bunkers():
    out = []
    for site in parse(os.path.join(LAYERS, 'BunkerTriggers.layer')).blocks:
        if not site.coords():
            continue
        x, _, z = site.coords()
        raw = site.attrs.get('m_sZoneName', '').strip('"')
        if 'Keycard04' in raw:
            name = 'Level 4 Bunker'
        elif 'Airfield' in raw:
            name = ('Northwest' if x < 7680 else 'Northeast') + ' Airfield Bunker'
        else:
            name = raw.replace('Bunker Loot', '').strip().replace('Tisy0', 'Tisy Bunker ')
        out.append({'name': name, 'icon': 'bunker', 'x': round(x), 'z': round(z)})
    return out


def badge(name, glyph):
    """64 px icon in the in-game badge style: grey disc, dark red ring, white glyph."""
    big = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.ellipse((6, 6, 250, 250), fill=(110, 18, 18, 255))
    d.ellipse((22, 22, 234, 234), fill=(58, 58, 58, 255))
    glyph(d, (255, 255, 255, 255))
    big.resize((64, 64), Image.LANCZOS).save(os.path.join(OUT_DIR, 'icons', name + '.png'), optimize=True)


def bunker_glyph(d, white):
    d.pieslice((58, 92, 198, 232), 180, 360, fill=white)
    d.rectangle((44, 160, 212, 176), fill=white)
    d.rectangle((108, 122, 148, 162), fill=(58, 58, 58, 255))
    d.rectangle((96, 70, 160, 84), fill=white)


def plane_glyph(d, white):
    d.polygon([(128, 46), (140, 70), (140, 112), (206, 146), (206, 162), (140, 144), (138, 188), (162, 206),
               (162, 216), (128, 206), (94, 216), (94, 206), (118, 188), (116, 144), (50, 162), (50, 146),
               (116, 112), (116, 70)], fill=white)


def main():
    zones = tier_zones()
    pois = black_market() + bunkers()
    pois += [{'name': n, 'icon': 'airfield', 'x': x, 'z': z} for n, x, z in AIRFIELDS]
    badge('bunker', bunker_glyph)
    badge('airfield', plane_glyph)
    data = {
        'generated': date.today().isoformat(),
        'tiers': zones,
        'poiTypes': {'bunker': {'label': 'Bunker', 'hidden': False}, 'airfield': {'label': 'Airfield', 'hidden': False}},
        'pois': pois,
    }
    with open(os.path.join(OUT_DIR, 'map-layers.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('// Generated by tools/map/build_layers.py from the ReforgedZ Dev Chernarus layers. Do not edit by hand.\n')
        f.write('// Loot tier zones, the moving black market\'s possible spots, bunkers and airfields.\n')
        f.write('const MAP_LAYERS = { chernarus: ' + json.dumps(data, separators=(',', ':')) + ' };\n')
    print('tier zones', len(zones), '| black market spots', sum(p['icon'] == 'blackmarket' for p in pois),
          '| bunkers', sum(p['icon'] == 'bunker' for p in pois), '| airfields', len(AIRFIELDS))


main()
