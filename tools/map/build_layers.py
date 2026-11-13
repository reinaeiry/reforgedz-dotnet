"""Builds the website map's game layers (public/map/map-layers.js + public/map/icons/) from the
ReforgedZ Dev Chernarus layers, so the site shows the same places and icons players see on the in-game map.

Usage: py tools/map/build_layers.py "<addons folder>" ["<terrain folder>"]
       addons folder: holds "ReforgedZ Dev" and "ReforgedZ Misc"
       terrain folder: the Chernarus terrain mod's Worlds/ and Prefabs/ unpacked from its data.pak (the toolkit's
       archive reader); adds the police stations, hospitals and other icon buildings the terrain itself places

Never shown: missions, quests, supply drops, stashes, bases, keys / keycards, anti-cheat zones.
"""
import glob
import json
import os
import re
import sys
from datetime import date

from PIL import Image, ImageDraw

ADDONS = sys.argv[1]
TERRAIN = sys.argv[2] if len(sys.argv) > 2 else None
DEV = os.path.join(ADDONS, 'ReforgedZ Dev')
LAYERS = os.path.join(DEV, 'Worlds', 'Chernarus', 'ChernarusReforgedZ_Layers')
ATLAS = os.path.join(ADDONS, 'ReforgedZ Misc', 'UI', 'Icons', 'ReforgedZIcons-100_atlas.tga')
IMAGESET = os.path.join(DEV, 'UI', 'Icons', 'ReforgedZIcons.imageset')
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'map')

# RZ_EMapLocationIcon (Scripts/Game/Map/RZ_MapLocationMarker.c), in enum order.
ICON_ENUM = ['WELL', 'CONCRETE_MIXER', 'SALVAGE_STATION', 'CRAFTING_WORKBENCH', 'SAWMILL', 'FURNACE', 'SHIPWRECK',
             'HERO_MISSION', 'BANDIT_MISSION', 'SAFEZONE', 'BLACKMARKET', 'DRUG_DEALER', 'ABANDONED_BASE', 'HERO_QUEST',
             'BANDIT_QUEST', 'POLICE', 'HOSPITAL', 'QUARRY', 'TOXIC_ZONE', 'FIRE_STATION', 'BASE_FLAG', 'SUPPLY_DROP',
             'STASH', 'BOAT_TRADER', 'OIL_RIG', 'AIRCRAFT_CARRIER', 'VIPER_ARCADE_MACHINE',
             'DEAD_SPRINT_ARCADE_MACHINE', 'KING_OF_THE_CASTLE']
# Icon -> (imageset quad, website layer). Icons not listed here never reach the website.
ICONS = {
    'SAFEZONE': ('Safezone', 'safezone'),
    'BLACKMARKET': ('Blackmarket', 'blackmarket'),
    'POLICE': ('Police', 'police'),
    'HOSPITAL': ('Hospital', 'services'),
    'FIRE_STATION': ('FireStation', 'services'),
    'WELL': ('Well', 'services'),
    'FURNACE': ('Furnace', 'crafting'),
    'SAWMILL': ('Sawmill', 'crafting'),
    'SALVAGE_STATION': ('Salvage_Station', 'crafting'),
    'CRAFTING_WORKBENCH': ('Crafting_Workbench', 'workbench'),
    'CONCRETE_MIXER': ('Concrete_Mixer', 'workbench'),
    'QUARRY': ('Quarry', 'crafting'),
    'BOAT_TRADER': ('Boat_Trader', 'traders'),
    'DRUG_DEALER': ('Drug_Dealer', 'traders'),
    'OIL_RIG': ('Oil_Rig', 'landmarks'),
    'AIRCRAFT_CARRIER': ('Aircraft_Carrier', 'landmarks'),
    'TOXIC_ZONE': ('ToxicZone', 'landmarks'),
    'VIPER_ARCADE_MACHINE': ('Viper_Arcade', 'landmarks'),
    'DEAD_SPRINT_ARCADE_MACHINE': ('Dead_Sprint_Arcade', 'landmarks'),
}
# Layer folders that hold missions, quests or keys: skipped whatever they contain.
SKIP_FOLDERS = {'MissonSpawns', 'Questing', 'Event', 'Spawners', 'ZombieSpawns', 'AnimalSpawners', 'OreSpawners',
                'Playerspawns', 'VehicleSpawns', 'Triggers', 'BuildBlock', 'Tiers'}
AIRFIELDS = [('Northwest Airfield', 4674, 10083), ('Northeast Airfield', 12043, 12684), ('Balota Airstrip', 4875, 2350)]

HEADER = re.compile(r'^(\$grp\s+)?(?:(\w+)\s+)?(\w+)(?:\s+(\w+))?\s*(?::\s*"([^"]*)")?\s*\{$')


class Node:
    def __init__(self, cls, ref):
        self.cls, self.ref = cls, ref
        self.attrs = {}
        self.blocks = []    # sub-blocks: components, child entities, points
        self.points = []

    def coords(self):
        v = self.attrs.get('coords')
        return tuple(float(a) for a in v.split()[:3]) if v else None


def parse(path):
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
                m = HEADER.match(line)
                comp = re.match(r'^(\w+)\s+"[^"]*"\s*\{$', line)
                if comp:
                    node.blocks.append(block(Node(comp.group(1), None)))
                    continue
                if line == '{' or not m:
                    child = block(Node('', None))
                    node.blocks.extend(child.blocks if line == '{' else [child])
                    if line == '{':
                        node.attrs.update({k: v for k, v in child.attrs.items() if k not in node.attrs})
                    continue
                grp, a, b, c, ref = m.groups()
                cls = c or b or a
                if grp:
                    holder = block(Node('', None), group=True)
                    for inst in holder.blocks:
                        inst.cls, inst.ref = cls, ref
                        node.blocks.append(inst)
                    continue
                node.blocks.append(block(Node(cls, ref)))
                continue
            parts = line.split(None, 1)
            if len(parts) == 2:
                node.attrs[parts[0]] = parts[1]
        return node

    root = Node('ROOT', None)
    return block(root)


def ref_path(ref):
    return re.sub(r'^\{[0-9A-Fa-f]+\}', '', ref or '')


def icon_in(node):
    """MOD_MapIconComponent settings set directly on this node (prefab or placed instance): dict or None."""
    for b in node.blocks:
        if b.cls == 'MOD_MapIconComponent':
            return b.attrs
        if b.cls in ('components', '') and b.coords() is None:
            found = icon_in(b)
            if found is not None:
                return found
    return None


def has_block(node, cls):
    return any(b.cls == cls or (b.cls in ('components', '') and b.coords() is None and has_block(b, cls))
               for b in node.blocks)


PREFAB_CACHE = {}
TOP_CACHE = {}
CHILD_CACHE = {}
VANILLA = [os.path.join(ADDONS, '..', 'Dump', '$ArmaReforgerEXP'), os.path.join(ADDONS, '..', 'Dump', '$ArmaReforger')]
SKIP_PREFABS = ('Prefabs/Vegetation/', 'PrefabLibrary/', 'Prefabs/Rocks/', 'Prefabs/Particles/', 'Prefabs/Characters/')


def prefab_tops(path):
    """Top entity of every copy of a prefab: ReforgedZ Dev first (its override wins), then the terrain, then the
    base game. An override file only holds what it changes, so the original's children still count."""
    if path in TOP_CACHE:
        return TOP_CACHE[path]
    TOP_CACHE[path] = []
    if path and not path.startswith(SKIP_PREFABS):
        roots = [DEV] + ([TERRAIN] if TERRAIN else []) + VANILLA[:1]
        for root in roots:
            full = os.path.join(root, path)
            if os.path.isfile(full):
                blocks = parse(full).blocks
                if blocks:
                    TOP_CACHE[path].append(blocks[0])
    return TOP_CACHE[path]


def prefab_top(path):
    tops = prefab_tops(path)
    return tops[0] if tops else None


def prefab_children(path):
    """Icons on the entities inside a prefab (a building's furniture, a composition's props), as offsets."""
    if path in CHILD_CACHE:
        return CHILD_CACHE[path]
    CHILD_CACHE[path] = []
    tops = prefab_tops(path)
    if not tops or prefab_info(path)[1]:
        return []
    hits = []
    for top in tops:
        hits += prefab_children(ref_path(top.ref))
        walk(top, (0.0, 0.0, 0.0), False, hits)
    CHILD_CACHE[path] = hits
    return hits


def prefab_info(path):
    """(icon settings merged down the inheritance chain, suppresses child icons) for a Dev prefab path."""
    if path in PREFAB_CACHE:
        return PREFAB_CACHE[path]
    PREFAB_CACHE[path] = ({}, False)
    top = prefab_top(path)
    if top is None:
        return PREFAB_CACHE[path]
    parent_icon, parent_supp = prefab_info(ref_path(top.ref))
    icon = dict(parent_icon)
    own = icon_in(top)
    if own is not None:
        icon['_has'] = True
        icon.update(own)
    result = (icon, parent_supp or has_block(top, 'MOD_MapIconSuppressorComponent'))
    PREFAB_CACHE[path] = result
    return result


def resolve_icon(node):
    icon, suppress = prefab_info(ref_path(node.ref))
    icon = dict(icon)
    own = icon_in(node)
    if own is not None:
        icon['_has'] = True
        icon.update(own)
    suppress = suppress or has_block(node, 'MOD_MapIconSuppressorComponent')
    if not icon.get('_has') or icon.get('Enabled') == '0' or icon.get('m_bHideIcon') == '1':
        return None, suppress
    value = icon.get('m_eIcon', 'WELL')
    name = ICON_ENUM[int(value)] if value.isdigit() else value
    label = icon.get('m_sLabel', '').strip('"')
    return (name, label), suppress


def walk(node, origin, suppressed, out):
    for child in node.blocks:
        local = child.coords()
        if local is None:
            continue
        world = (origin[0] + local[0], origin[1] + local[1], origin[2] + local[2])
        found, supp = resolve_icon(child)
        if found and not suppressed:
            out.append((found[0], found[1], world))
        if not (suppressed or supp):
            for icon, label, off in prefab_children(ref_path(child.ref)):
                out.append((icon, label, (world[0] + off[0], world[1] + off[1], world[2] + off[2])))
        walk(child, world, suppressed or supp, out)


def tier_zones():
    zones = []
    for path in sorted(glob.glob(os.path.join(LAYERS, 'Tiers', '*.layer'))):
        for shape in parse(path).blocks:
            ox, _, oz = shape.coords() or (0, 0, 0)
            tier = None
            for b in shape.blocks:
                t = b.attrs.get('m_TierFlags') or (icon_in(b) or {}).get('m_TierFlags')
                if t:
                    tier = t
            if not tier or len(shape.points) < 3:
                continue
            zones.append({'tier': int(re.sub(r'\D', '', tier) or 1),
                          'points': [[round(ox + p[0]), round(oz + p[2])] for p in shape.points]})
    return zones


def black_market():
    spots = []
    for path in glob.glob(os.path.join(LAYERS, 'Blackmarket', '*.layer')):
        for site in parse(path).blocks:
            if 'RZ_BlackMarketSite' in (site.ref or '') and site.coords():
                x, _, z = site.coords()
                spots.append({'layer': 'blackmarket', 'icon': 'Blackmarket', 'name': 'Black market (possible spot)',
                              'x': round(x), 'z': round(z)})
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
        out.append({'layer': 'bunkers', 'icon': 'bunker', 'name': name, 'x': round(x), 'z': round(z)})
    return out


def badge(name, glyph):
    """A 64 px icon in the in-game badge style (grey disc, dark red ring, white glyph) for places the game
    has no icon for."""
    big = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.ellipse((6, 6, 250, 250), fill=(110, 18, 18, 255))
    d.ellipse((22, 22, 234, 234), fill=(58, 58, 58, 255))
    glyph(d)
    big.resize((64, 64), Image.LANCZOS).save(os.path.join(OUT_DIR, 'icons', name + '.png'), optimize=True)


def bunker_glyph(d):
    white = (255, 255, 255, 255)
    d.pieslice((58, 92, 198, 232), 180, 360, fill=white)
    d.rectangle((44, 160, 212, 176), fill=white)
    d.rectangle((108, 122, 148, 162), fill=(58, 58, 58, 255))
    d.rectangle((96, 70, 160, 84), fill=white)


def plane_glyph(d):
    white = (255, 255, 255, 255)
    d.polygon([(128, 46), (140, 70), (140, 112), (206, 146), (206, 162), (140, 144), (138, 188), (162, 206),
               (162, 216), (128, 206), (94, 216), (94, 206), (118, 188), (116, 144), (50, 162), (50, 146),
               (116, 112), (116, 70)], fill=white)


def main():
    found = []
    for path in sorted(glob.glob(os.path.join(LAYERS, '**', '*.layer'), recursive=True)):
        rel = os.path.relpath(path, LAYERS).replace('\\', '/')
        if rel.split('/')[0] in SKIP_FOLDERS or rel.split('/')[0].replace('.layer', '') in SKIP_FOLDERS:
            continue
        hits = []
        walk(parse(path), (0.0, 0.0, 0.0), False, hits)
        found.extend((rel, *h) for h in hits)

    if TERRAIN:
        for path in sorted(glob.glob(os.path.join(TERRAIN, 'Worlds', '**', '*.layer'), recursive=True)):
            hits = []
            walk(parse(path), (0.0, 0.0, 0.0), False, hits)
            found.extend(('terrain', *h) for h in hits)

    points, seen, report = [], set(), {}
    for rel, icon, label, (x, _, z) in found:
        if icon not in ICONS or icon == 'BLACKMARKET':
            report.setdefault('skipped ' + icon, 0)
            report['skipped ' + icon] += 1
            continue
        quad, layer = ICONS[icon]
        key = (icon, round(x / 25), round(z / 25))
        if key in seen:
            continue
        seen.add(key)
        points.append({'layer': layer, 'icon': quad, 'name': label or quad.replace('_', ' '),
                       'x': round(x), 'z': round(z)})
        report[icon] = report.get(icon, 0) + 1

    points += black_market() + bunkers()
    points += [{'layer': 'airfields', 'icon': 'airfield', 'name': n, 'x': x, 'z': z} for n, x, z in AIRFIELDS]
    zones = tier_zones()

    # Icons cut from the in-game icon sheet
    atlas = Image.open(ATLAS).convert('RGBA')
    text = open(IMAGESET, encoding='utf-8').read()
    os.makedirs(os.path.join(OUT_DIR, 'icons'), exist_ok=True)
    used = {p['icon'] for p in points}
    for name, px, py, sx, sy in re.findall(
            r'ImageSetDefClass (\w+) \{\s*Pos (\d+) (\d+)\s*Size (\d+) (\d+)', text):
        if name in used:
            tile = atlas.crop((int(px), int(py), int(px) + int(sx), int(py) + int(sy))).resize((64, 64), Image.LANCZOS)
            tile.save(os.path.join(OUT_DIR, 'icons', name + '.png'), optimize=True)

    badge('bunker', bunker_glyph)
    badge('airfield', plane_glyph)

    data = {'generated': date.today().isoformat(), 'tiers': zones,
            'points': sorted(points, key=lambda p: (p['layer'], p['name'], p['x']))}
    with open(os.path.join(OUT_DIR, 'map-layers.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('// Generated by tools/map/build_layers.py from the ReforgedZ Dev Chernarus layers. Do not edit by hand.\n')
        f.write('const MAP_LAYERS = { chernarus: ')
        f.write(json.dumps(data, separators=(',', ':')))
        f.write(' };\n')

    by_layer = {}
    for p in points:
        by_layer[p['layer']] = by_layer.get(p['layer'], 0) + 1
    print('tier zones:', [(z['tier'], len(z['points'])) for z in zones])
    print('points by layer:', by_layer)
    print('icons:', report)


main()
