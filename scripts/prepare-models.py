"""Convert the original scan data and the calibrated Unity meshes for browser use."""

import argparse
import gzip
import json
import math
from pathlib import Path
import re
import struct

import numpy as np


VIEW = np.diag([1.0, 1.0, -1.0])  # Unity world space to browser world space
POINT = np.dtype([("xyz", "<f4", 3), ("rgb", "u1", 3), ("part", "u1")])
SPC_FIELDS = ("x", "y", "z", "red", "green", "blue", "patch_id")

TERMS = {
    "metal": "金属", "concrete": "混凝土", "stone": "石材", "brick": "砖石",
    "roof": "屋顶", "railing": "栏杆", "floor": "楼板", "stair": "楼梯",
    "basic wall": "墙面", "knee wall": "矮墙", "inclined structural wall": "倾斜承重墙",
    "structural column": "结构柱", "structural framing": "结构构架", "curtain wall": "幕墙",
    "banner": "横幅", "ground": "地面", "street furniture": "室外设施",
    "rear vertical face": "背面立面", "upper inclined rear surface": "背面上部斜面",
    "right vertical face": "右侧立面", "upper inclined front surface": "正面上部斜面",
    "lower edge of inclined rear surface": "背面斜面下缘",
    "lower edge of inclined front surface": "正面斜面下缘", "front vertical face": "正面立面",
    "pedestal or base plane": "底座或基面", "left vertical face": "左侧立面",
    "applied plaque, left face": "左侧铭牌", "relief plaque, upper front": "正面上部浮雕牌",
    "inscription plaque, lower front": "正面下部铭牌",
    "metal plate": "金属板", "relief map": "浮雕地图", "inscription": "铭文",
}

MONUMENT_COLORS = [
    "#897bc2", "#8ec5f4", "#f2ac7f", "#c3e68e", "#7fc9ac", "#e3b76a",
    "#bd897d", "#c77550", "#d1efaa", "#eb9ca5", "#d657c8", "#6db3bb",
]


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def bounds(xyz):
    return np.stack((xyz.min(axis=0), xyz.max(axis=0))).round(5).tolist()


def ply_header(path):
    fields = []
    kind = count = element = None
    with path.open("rb") as stream:
        if stream.readline().strip() != b"ply":
            raise ValueError(f"Not a PLY file: {path}")
        lines = 1
        for raw in stream:
            lines += 1
            row = raw.decode("ascii").split()
            if not row:
                continue
            if row[0] == "end_header":
                if not count or not fields:
                    raise ValueError(f"Missing vertex data in {path}")
                return kind, count, fields, lines, stream.tell()
            if row[0] == "format":
                kind = row[1]
            if row[0] == "element":
                element = row[1]
                if element == "vertex":
                    count = int(row[2])
            if row[0] == "property" and element == "vertex":
                fields.append((row[2], row[1]))
    raise ValueError(f"Incomplete PLY header: {path}")


def read_spc(path):
    kind, count, fields, lines, _ = ply_header(path)
    if kind != "ascii":
        raise ValueError(f"Expected the labeled ASCII point cloud: {path}")
    names = [name for name, _ in fields]
    dtype = np.dtype(list(zip(SPC_FIELDS, ["f8"] * 3 + ["u1"] * 3 + ["i4"])))
    points = np.loadtxt(path, dtype=dtype, skiprows=lines, max_rows=count,
                        usecols=[names.index(field) for field in SPC_FIELDS])
    if len(points) != count:
        raise ValueError(f"Incomplete point cloud: {path}")
    xyz = np.column_stack([points[k] for k in SPC_FIELDS[:3]])
    rgb = np.column_stack([points[k] for k in SPC_FIELDS[3:6]])
    return xyz, rgb, points["patch_id"]


def unity_mesh(path):
    return path.read_text(encoding="utf-8-sig")


def hex_field(text, name):
    return bytes.fromhex(re.search(rf"^\s*{name}: ([\da-f]+)\s*$", text, re.M)[1])


def monument_patches(scene):
    result = {}
    for block in re.findall(r"info: '(Patch ID: \d+[\s\S]*?)'", scene):
        clean = " ".join(block.split())
        record = re.fullmatch(r"Patch ID: (\d+) Material: (.+?) Structure: (.+?) Decorative Element: (.+)", clean)
        patch, material, structure, decoration = record.groups()
        patch = int(patch)
        result[patch] = {
            "name": TERMS.get(structure, structure), "nameEn": structure.capitalize(),
            "material": TERMS.get(material, material), "materialEn": material.capitalize(),
            "structure": TERMS.get(structure, structure), "structureEn": structure.capitalize(),
            "color": MONUMENT_COLORS[patch],
            "decoration": TERMS.get(decoration, decoration) if decoration != "none" else "无",
            "decorationEn": decoration.capitalize(),
        }
    if set(result) != set(range(12)):
        raise ValueError("Monument scene must describe patches 0–11")
    return result


AULA_FEATURES = {
    "inclined_structural_wall": "inclined structural wall", "structural_column": "structural column",
    "structural_framing": "structural framing", "unclassified_street_furniture": "street furniture",
    "curtain_wall": "curtain wall", "basicwall": "basic wall", "kneewall": "knee wall",
    "railing": "railing", "floor": "floor", "stair": "stair", "banner": "banner",
    "ground": "ground", "roof": "roof",
}

# Confirmed against the geometry of the supplied segmented scan. These IDs are
# specific to its Gaussian PLYs and independent of the SPC patch IDs.
AULA_GAUSSIAN_COMPONENTS = {
    1: "roof",
    5: "walls", 7: "walls", 16: "walls", 17: "walls", 23: "walls",
    32: "windows", 35: "windows",
}
AULA_SPC_COMPONENTS = {
    "roof": "roof", "basic wall": "walls", "knee wall": "walls",
    "inclined structural wall": "walls", "curtain wall": "windows",
}


def aula_patches(classification, patch_names):
    categories = {part["structure"]["structuralRole"]: part.get("material", {}).get("materialType")
                  for part in read_json(classification)["patches"].values()}
    result = {}
    for key, value in read_json(patch_names).items():
        prefix = next(name for name in AULA_FEATURES if value.startswith(name))
        structure = AULA_FEATURES[prefix]
        zh, en = TERMS.get(structure, structure), structure.capitalize()
        suffix = value[len(prefix):].lstrip("_")
        detail = f" · {suffix.upper()}" if suffix else ""
        result[int(key)] = {"name": zh + detail, "nameEn": en + detail,
                            "structure": zh, "structureEn": en}
        component = AULA_SPC_COMPONENTS.get(structure)
        if component:
            result[int(key)]["component"] = component
        material = categories.get(structure)
        if material:
            result[int(key)].update(material=TERMS.get(material, material), materialEn=material.capitalize())
    return result


def evenly_spaced(count, keep):
    return (np.arange(keep, dtype=np.int64) * count + count // 2) // keep


def write_spc(directory, xyz, rgb, labels, patches, budget, point_size):
    records = []
    rng = np.random.default_rng(15281)
    sampled = np.empty(min(budget + 256 * 80, len(xyz)), dtype=POINT)
    cursor = 0
    for key in np.unique(labels):
        indices = np.flatnonzero(labels == key)
        limit = min(len(indices), max(80, round(len(indices) * budget / len(labels))))
        if limit < len(indices):
            indices = rng.choice(indices, size=limit, replace=False)
        fallback = {"name": "未分类", "nameEn": "Unclassified"} if key <= 0 else {
            "name": f"分块 {key}", "nameEn": f"Patch {key}",
        }
        record = patches.get(int(key), fallback)
        dest = sampled[cursor:cursor + limit]
        dest["xyz"] = xyz[indices]
        dest["rgb"] = rgb[indices]
        dest["part"] = 0  # 16-byte row alignment for browser Float32Array views
        records.append({"id": int(key), "start": cursor, "count": limit, **record})
        cursor += limit
    sampled[:cursor].tofile(directory / "points.bin")
    write_json(directory / "spc.json", {"file": "points.bin", "bounds": bounds(sampled["xyz"][:cursor]),
                                        "pointSize": point_size, "count": cursor,
                                        "sourceCount": len(xyz), "parts": records})
    print(f"{directory.name} SPC: {cursor:,} / {len(xyz):,} RGB points", flush=True)


def quaternion_matrix(q):
    x, y, z, w = np.asarray(q) / np.linalg.norm(q)
    return np.array([
        [1 - 2*(y*y + z*z), 2*(x*y - z*w), 2*(x*z + y*w)],
        [2*(x*y + z*w), 1 - 2*(x*x + z*z), 2*(y*z - x*w)],
        [2*(x*z - y*w), 2*(y*z + x*w), 1 - 2*(x*x + y*y)],
    ])


def scene_transform(scene, file_id):
    block = re.search(rf"^--- !u!4 &{file_id}\n(.*?)(?=^--- |\Z)", scene, re.M | re.S)[1]
    def vector(key):
        line = re.search(rf"m_Local{key}: \{{([^}}]+)\}}", block)[1]
        return np.array([float(value.split(":")[1]) for value in line.split(",")])
    return quaternion_matrix(vector("Rotation")) @ np.diag(vector("Scale")), vector("Position")


def dict_vector(obj):
    return np.array([obj[axis] for axis in "xyz"])


def transform_spec(matrix, translation):
    result = np.eye(4)
    result[:3, :3], result[:3, 3] = matrix, translation
    if np.linalg.det(matrix) <= 0:
        raise ValueError("Gaussian assets require a proper rotation and positive scale")
    return result.ravel().tolist()


def read_gaussians(path, header, limit):
    kind, count, columns, _, offset = header
    if kind != "binary_little_endian" or any(dtype != "float" for _, dtype in columns):
        raise ValueError(f"Unexpected Gaussian PLY layout: {path}")
    vertices = np.memmap(path, mode="r", dtype=np.dtype([(name, "<f4") for name, _ in columns]),
                         offset=offset, shape=(count,))
    if limit < count:
        vertices = vertices[evenly_spaced(count, limit)]
    return vertices


def byte_values(values):
    return np.round(values).clip(0, 255).astype("u1")


def write_spz(path, vertices, xyz, degree, scale_boost):
    # SPZ v2 stores 24-bit fixed-point centers and quantized attributes in separate arrays.
    coeffs = (degree + 1)**2 - 1
    def columns(prefix, count, start=0):
        return np.column_stack([vertices[f"{prefix}_{i}"] for i in range(start, start + count)])

    fixed = np.rint(xyz * 4096).astype("<i4").reshape(-1)
    if np.abs(fixed).max() >= (1 << 23):
        raise ValueError("Splat centers exceed the SPZ coordinate range")
    pos = fixed.view("u1").reshape(-1, 4)[:, :3]
    alpha = byte_values(255 / (1 + np.exp(-vertices["opacity"].clip(-40, 40))))
    color = byte_values(255 * (0.5 + 0.15 * columns("f_dc", 3)))
    scales = byte_values((columns("scale", 3) + math.log(scale_boost) + 10) * 16)
    quat = columns("rot", 4)
    quat /= np.maximum(np.linalg.norm(quat, axis=1, keepdims=True), 1e-12)
    quat[quat[:, 0] < 0] *= -1
    rotations = byte_values(quat[:, 1:] * 127.5 + 127.5)
    with gzip.open(path, "wb", compresslevel=5) as file:
        file.write(struct.pack("<IIIBBBB", 0x5053474E, 2, len(vertices), degree, 12, 0, 0))
        for array in (pos, alpha, color, scales, rotations):
            file.write(array.tobytes())
        if coeffs:
            source_coeffs = sum(name.startswith("f_rest_") for name in vertices.dtype.names) // 3
            sh = np.stack([columns("f_rest", coeffs, channel * source_coeffs)
                           for channel in range(3)], axis=2)
            # SPZ v2: SH degree 1 is quantized to 5 significant bits, later degrees to 4.
            encoded = np.rint(sh * 128 + 128).astype(np.int32)
            encoded[:, :3] = ((encoded[:, :3] + 4) // 8) * 8
            encoded[:, 3:] = ((encoded[:, 3:] + 8) // 16) * 16
            file.write(encoded.clip(0, 255).astype("u1").tobytes())


def write_splats(directory, paths, patches, matrix, translate, center, budget, degree):
    headers = [ply_header(path) for path in paths]
    counts = np.array([header[1] for header in headers])
    weights = 0.84 * counts / counts.sum() + 0.16 * np.sqrt(counts) / np.sqrt(counts).sum()
    mesh_dir = directory / "splats"
    mesh_dir.mkdir(exist_ok=True)
    parts, world_bounds = [], []
    translation = matrix @ center + translate
    for path, header, weight in zip(paths, headers, weights):
        patch = int(path.stem.rsplit("_", 1)[1])
        limit = min(header[1], max(96, round(budget * weight))) if budget else header[1]
        vertices = read_gaussians(path, header, limit)
        xyz = np.column_stack([vertices[k] for k in "xyz"])
        local = xyz - center
        growth = min(1.85, (header[1] / limit)**0.23)
        name = f"splats/{patch:03}.spz"
        write_spz(directory / name, vertices, local, degree, growth)
        coords = local @ matrix.T + translation
        patch_bounds = bounds(coords)
        world_bounds.extend(patch_bounds)
        parts.append({"id": patch, "file": name, "count": len(vertices), "bounds": patch_bounds,
                      "name": f"扫描分块 {patch:02}", "nameEn": f"Scan patch {patch:02}", **patches.get(patch, {})})
    count = sum(part["count"] for part in parts)
    write_json(directory / "s3dgs.json", {"transform": transform_spec(matrix, translation),
                                         "bounds": bounds(np.array(world_bounds)), "count": count,
                                         "sourceCount": int(counts.sum()), "parts": parts})
    print(f"{directory.name} S3DGS: {count:,} / {counts.sum():,} Gaussians, {len(parts)} patches", flush=True)


class Glb:
    """Minimal glTF writer for static indexed meshes and diffuse materials."""
    def __init__(self):
        self.json = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": []}],
                     "nodes": [], "meshes": [], "materials": [], "accessors": [], "bufferViews": []}
        self.data = bytearray()
        self.world_bounds = []

    def accessor(self, array, kind, component, target, limits=None):
        views, accessors = self.json["bufferViews"], self.json["accessors"]
        padding = (-len(self.data)) % 4
        self.data.extend(b"\0" * padding)
        views.append({"buffer": 0, "byteOffset": len(self.data), "byteLength": array.nbytes, "target": target})
        self.data.extend(array.tobytes())
        info = {"bufferView": len(views) - 1, "componentType": component, "count": len(array), "type": kind}
        if limits:
            info["min"], info["max"] = limits
        accessors.append(info)
        return len(accessors) - 1

    def add(self, part, positions, normals, indices, rgb, opacity, component=None):
        self.world_bounds.extend(bounds(positions))
        unit = normals / np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-10)
        limits = [positions.min(axis=0).tolist(), positions.max(axis=0).tolist()]
        vertex = self.accessor(positions, "VEC3", 5126, 34962, limits)
        normal = self.accessor(unit.astype("<f4"), "VEC3", 5126, 34962)
        index = self.accessor(indices.flatten().astype("<u4"), "SCALAR", 5125, 34963)
        linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055)**2.4 for c in rgb]
        material = {"name": part["name"], "doubleSided": True,
                    "pbrMetallicRoughness": {"baseColorFactor": [*linear, opacity],
                                             "metallicFactor": 0, "roughnessFactor": 0.86}}
        if opacity < 1:
            material["alphaMode"] = "BLEND"
        slot = len(self.json["nodes"])
        self.json["materials"].append(material)
        self.json["meshes"].append({"primitives": [{"attributes": {"POSITION": vertex, "NORMAL": normal},
                                                     "indices": index, "material": slot}]})
        extra = {"partId": part["id"]}
        name = f"part_{part['id']}"
        if component:
            extra["component"] = component
            name += f"_{component}"
        self.json["nodes"].append({"mesh": slot, "name": name, "extras": extra})
        self.json["scenes"][0]["nodes"].append(slot)

    def write(self, directory, parts):
        self.json["buffers"] = [{"byteLength": len(self.data)}]
        data = json.dumps(self.json, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        data += b" " * ((-len(data)) % 4)
        with (directory / "bim.glb").open("wb") as file:
            file.write(struct.pack("<4sII", b"glTF", 2, 28 + len(data) + len(self.data)))
            file.write(struct.pack("<I4s", len(data), b"JSON"))
            file.write(data)
            file.write(struct.pack("<I4s", len(self.data), b"BIN\0"))
            file.write(self.data)
        write_json(directory / "hdim.json", {"file": "bim.glb", "bounds": bounds(np.array(self.world_bounds)),
                                             "count": sum(part["count"] for part in parts), "parts": parts})
        print(f"{directory.name} HBIM: {len(parts)} material groups, {len(self.data) / 2**20:.1f} MiB", flush=True)


def monument_bim(directory, source):
    text = unity_mesh(source / "HK_Monument_IFC.asset")
    vertex = np.frombuffer(hex_field(text, "_typelessdata"), "<f4").reshape(-1, 6)
    positions = (vertex[:, :3] @ VIEW.T).astype("<f4")
    normals = vertex[:, 3:] @ VIEW.T
    indices = np.frombuffer(hex_field(text, "m_IndexBuffer"), "<u2")
    submeshes = re.findall(r"firstByte: (\d+)\s+indexCount: (\d+)\s+topology: 0\s+baseVertex: 0", text)
    names = [
        ("Red_Brick", "红砖", "Red brick", "砖石", "Brick", "碑体", "Monument body"),
        ("Red_Plaque", "红褐色铭牌", "Red-brown plaque", "金属", "Metal", "铭牌", "Plaque"),
        ("White", "浅色饰面", "Light finish", "浅色饰面", "Light finish", "铭牌", "Plaque"),
        ("Gray_White", "灰白饰面", "Gray-white finish", "灰白饰面", "Gray-white finish", "碑体", "Monument body"),
        ("HEI", "深色铭文", "Dark lettering", "深色饰面", "Dark finish", "铭文", "Inscription"),
    ]
    glb, parts = Glb(), []
    if len(submeshes) != len(names):
        raise ValueError("Unexpected IFC-derived material count")
    for patch, ((offset, count), labels) in enumerate(zip(submeshes, names), 1):
        file, name, name_en, material, material_en, structure, structure_en = labels
        offset, count = int(offset) // 2, int(count)
        faces = indices[offset:offset + count].reshape(-1, 3)[:, [0, 2, 1]]
        used, remapped = np.unique(faces, return_inverse=True)
        tint = re.search(r"_Color: \{r: ([\d.]+), g: ([\d.]+), b: ([\d.]+), a: ([\d.]+)\}",
                         (source / f"{file}.mat").read_text(encoding="utf-8-sig"))
        r, g, b, alpha = map(float, tint.groups())
        part = {"id": patch, "name": name, "nameEn": name_en, "material": material, "materialEn": material_en,
                "structure": structure, "structureEn": structure_en, "count": len(faces)}
        glb.add(part, positions[used], normals[used], remapped, [r, g, b], alpha)
        parts.append(part)
    glb.write(directory, parts)


AULA_MATERIALS = {
    "Concrete": ("混凝土", "Concrete", "主体", "Main structure"),
    "Floor": ("楼面", "Floor finish", "楼板", "Floor"), "Pine": ("松木", "Pine", "饰面", "Finish"),
    "Glazing": ("玻璃", "Glazing", "幕墙", "Curtain wall"),
    "WhiteFacade": ("白色外墙", "White façade", "外墙", "Façade"),
    "Mass": ("建筑主体", "Building mass", "主体", "Main structure"),
    "Frame": ("窗框", "Window frame", "门窗", "Openings"),
    "FoldedRoof": ("折板屋顶", "Folded roof", "屋顶", "Roof"),
    "Metalwork": ("金属构件", "Metalwork", "构件", "Building elements"),
    "Grass": ("草地", "Grass", "地面", "Ground"), "Stone": ("石材", "Stone", "铺装", "Paving"),
    "Walkway": ("步道", "Walkway", "步道", "Walkway"),
    "Pebbles": ("卵石", "Pebbles", "铺装", "Paving"), "BlueStone": ("青石", "Bluestone", "铺装", "Paving"),
}


def aula_surface_groups(material, positions, faces, auditorium):
    if material == "FoldedRoof":
        return [("roof", faces)]
    if material not in {"Concrete", "WhiteFacade", "Glazing", "Frame"}:
        return [(None, faces)]

    # The OBJ also models the adjacent library and grounds. Use the measured
    # auditorium survey bounds to keep those surfaces out of the linked groups.
    triangles = positions[faces[:, :, 0]]
    center = triangles.mean(axis=1)
    lower, upper = auditorium
    in_aula = np.all((center >= lower) & (center <= upper), axis=1)
    if material in {"Concrete", "WhiteFacade"}:
        normal = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
        # Concrete slabs and the forecourt share the wall material in the OBJ.
        is_side = np.abs(normal[:, 1]) < 0.68 * np.linalg.norm(normal, axis=1)
        in_aula &= is_side
        component = "walls"
    else:
        component = "windows"
    groups = [(component, faces[in_aula]), (None, faces[~in_aula])]
    return [(key, group) for key, group in groups if len(group)]


def aula_bim(directory, source, matrix, translate, auditorium):
    positions, normals, by_material = [], [], {}
    with source.open(encoding="utf-8-sig") as file:
        for line in file:
            key, _, tail = line.strip().partition(" ")
            if key == "v":
                positions.append(tuple(map(float, tail.split()[:3])))
            elif key == "vn":
                normals.append(tuple(map(float, tail.split())))
            elif key == "usemtl":
                faces = by_material.setdefault(tail, [])
            elif key == "f":
                corners = [token.split("/") for token in tail.split()]
                if len(corners) != 3 or any(len(c) != 3 or not c[2] for c in corners):
                    raise ValueError("The AULA scene OBJ must contain triangulated faces with normals")
                faces.extend((int(c[0]) - 1, int(c[2]) - 1) for c in corners)

    positions = (np.array(positions) @ matrix.T + translate).astype("<f4")
    normals = np.array(normals) @ matrix.T
    mtl = {}
    for block in source.with_suffix(".mtl").read_text(encoding="utf-8-sig").split("newmtl ")[1:]:
        lines = block.splitlines()
        tint = next(line.split()[1:] for line in lines if line.startswith("Kd "))
        opacity = next((float(line.split()[1]) for line in lines if line.startswith("d ")), 1)
        mtl[lines[0].strip()] = (list(map(float, tint)), opacity)

    glb, parts = Glb(), []
    reverse_winding = np.linalg.det(matrix) < 0
    for patch, (material, faces) in enumerate(by_material.items(), 1):
        material_type = material.removeprefix("AULA_")
        label, label_en, structure, structure_en = AULA_MATERIALS.get(material_type, (material,) * 4)
        part = {"id": patch, "name": label, "nameEn": label_en, "material": label, "materialEn": label_en,
                "structure": structure, "structureEn": structure_en, "count": len(faces) // 3}
        triangles = np.asarray(faces, dtype=np.int64).reshape(-1, 3, 2)
        for component, group in aula_surface_groups(material_type, positions, triangles, auditorium):
            corners = group.reshape(-1, 2)
            vertex_keys = corners[:, 0] * len(normals) + corners[:, 1]
            used, remapped = np.unique(vertex_keys, return_inverse=True)
            if reverse_winding:
                remapped = remapped.reshape(-1, 3)[:, [0, 2, 1]]
            glb.add(part, positions[used // len(normals)], normals[used % len(normals)], remapped,
                    *mtl[material], component=component)
        parts.append(part)
    glb.write(directory, parts)


def prepare_monument(args):
    source = args.data / "Monument"
    assets = args.monument / "Assets"
    scene = (assets / "Scenes/GSTestScene_gs_seg.unity").read_text(encoding="utf-8-sig")
    output = args.out / "monument"
    output.mkdir(parents=True, exist_ok=True)
    patches = monument_patches(scene)
    _, rgb, labels = read_spc(source / "SPC/HK_id_refined.ply")
    mesh = np.frombuffer(hex_field(unity_mesh(assets / "Monument/SPC.asset"), "_typelessdata"), POINT)
    if len(mesh) != len(rgb) or not np.array_equal(mesh["rgb"], rgb):
        raise ValueError("Monument's Unity point mesh no longer matches PLY row order")
    write_spc(output, mesh["xyz"] @ VIEW.T, rgb, labels, patches, len(mesh), 0.014)
    monument_bim(output, assets / "Monument/HBIM_IFC")
    root, root_pos = scene_transform(scene, 124285804)
    patch, patch_pos = scene_transform(scene, 1609192435)
    paths = sorted((source / "3DGS/seg").glob("HK_GS_patchid_int_patch_*.ply"),
                   key=lambda path: int(path.stem.rsplit("_", 1)[1]))
    if len(paths) != len(patches):
        raise ValueError("Monument scan is missing segmented PLY files")
    write_splats(output, paths, patches, VIEW @ root @ patch, VIEW @ (root @ patch_pos + root_pos),
                 np.zeros(3), None, 3)


def prepare_aula(args):
    source = args.data / "AULA_and_block"
    preview = args.aula / "Assets/AulaPreview"
    profile = read_json(preview / "Alignment/alignment.json")
    manifest = read_json(preview / "Imported/manifest.json")
    scene = (args.aula / "Assets/Scenes/AULA_Preview.unity").read_text(encoding="utf-8-sig")
    output = args.out / "aula"
    output.mkdir(parents=True, exist_ok=True)
    xyz, rgb, labels = read_spc(source / "seg_block_pc/aula_id__down20.ply")
    origin = np.array([profile[f"surveyOrigin{axis}"] for axis in "XYZ"])
    survey = (xyz - origin)[:, [0, 2, 1]] @ VIEW.T
    labels_path = source / "seg_block_pc"
    patches = aula_patches(labels_path / "pathcid_20per.json", labels_path / "aula_pathcid_dense.json")
    write_spc(output, survey, rgb, labels, patches,
              args.aula_points, 0.25)
    root, root_pos = scene_transform(scene, 2072709687)
    mount, offset = scene_transform(scene, 599753553)
    auditorium_center = VIEW @ dict_vector(profile["commonCenter"])
    auditorium_half_size = dict_vector(profile["commonSize"]) / 2 + np.array([2.0, 0.0, 2.0])
    auditorium = auditorium_center - auditorium_half_size, auditorium_center + auditorium_half_size
    aula_bim(output, preview / "Imported/ColoredHBIM/AULA_Library_Color.obj",
             VIEW @ root @ mount @ np.diag([-1, 1, 1]), VIEW @ (root @ offset + root_pos), auditorium)

    reference = next(record for record in manifest["records"] if record["kind"] == "gs")
    original_center = dict_vector(reference["center"])
    alignment = np.array(profile["seg"]["matrix"]).reshape(4, 4)
    matrix = VIEW @ alignment[:3, :3] @ np.diag([1, -1, -1])
    translate = VIEW @ (alignment[:3, 3] - alignment[:3, :3] @ original_center)
    # Center in the raw segmented scan's coordinates to retain packed position precision.
    center = np.linalg.solve(matrix, dict_vector(profile["commonCenter"]) - translate)
    paths = sorted((source / "3dgs/seg_3dgs").glob("patch_*.ply"))
    expected = sum(record["kind"] == "gs-segment" for record in manifest["records"])
    if len(paths) != expected:
        raise ValueError(f"Expected {expected} AULA splat patches, found {len(paths)}")
    splat_links = {patch: {"component": key} for patch, key in AULA_GAUSSIAN_COMPONENTS.items()}
    write_splats(output, paths, splat_links, matrix, translate, center, args.aula_gaussians, 1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("D:/Dev/AULA_and_block"))
    parser.add_argument("--aula", type=Path, default=Path("D:/Workspace/UnityWorkSpace/XrRoam"))
    parser.add_argument("--monument", type=Path, default=Path("D:/Workspace/UnityWorkSpace/XrRoam_Monument"))
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "models")
    parser.add_argument("--scene", choices=("both", "aula", "monument"), default="both")
    parser.add_argument("--aula-points", type=int, default=1_350_000)
    parser.add_argument("--aula-gaussians", type=int, default=2_100_000)
    args = parser.parse_args()
    if args.scene in ("both", "monument"):
        prepare_monument(args)
    if args.scene in ("both", "aula"):
        prepare_aula(args)
