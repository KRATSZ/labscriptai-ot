"""Write the posed MuJoCo scene so the browser can orbit the real meshes.

The vertices are the ones already in the compiled model (enclosure, gantry,
tips). Playback is the same joint and liquid state the JPEG renderer uses.
The page does not ask for a new image while the mouse is moving.
"""

from __future__ import annotations

import json
from pathlib import Path

import mujoco
import numpy as np

_KIND = {
    int(mujoco.mjtGeom.mjGEOM_PLANE): "plane",
    int(mujoco.mjtGeom.mjGEOM_SPHERE): "sphere",
    int(mujoco.mjtGeom.mjGEOM_CAPSULE): "capsule",
    int(mujoco.mjtGeom.mjGEOM_CYLINDER): "cylinder",
    int(mujoco.mjtGeom.mjGEOM_BOX): "box",
    int(mujoco.mjtGeom.mjGEOM_MESH): "mesh",
}


def _nums(values, places: int = 5) -> list[float]:
    return [round(float(value), places) for value in values]


def _texture_index(model, matid: int, textures: list[dict]) -> int | None:
    """Index of a 2D material texture, or None. Skybox is not a surface map."""

    if matid < 0:
        return None
    role = int(mujoco.mjtTextureRole.mjTEXROLE_RGB)
    tex = int(model.mat_texid[matid, role])
    if tex < 0 or int(model.tex_type[tex]) != int(mujoco.mjtTexture.mjTEXTURE_2D):
        return None
    for index, item in enumerate(textures):
        if item["id"] == tex:
            return index
    name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_TEXTURE, tex) or f"tex{tex}"
    file = name[:-4] + ".png" if name.endswith("_tex") else f"{name}.png"
    textures.append({"id": tex, "file": file})
    return len(textures) - 1


def write_view(plan, scene, folder: Path) -> Path:
    model = scene.model
    bind_pos = model.geom_pos.copy()
    bind_size = model.geom_size.copy()
    bind_rgba = model.geom_rgba.copy()
    shots = []
    for key in plan.keys:
        scene.apply(key.q, key.state)
        shots.append(
            (
                scene.data.xpos.copy(),
                scene.data.xmat.copy(),
                model.geom_pos.copy(),
                model.geom_size.copy(),
                model.geom_rgba.copy(),
            )
        )
    scene.at(0.0)

    moving = []
    x0, m0 = shots[0][0], shots[0][1]
    for body in range(model.nbody):
        if any(
            np.max(np.abs(xpos[body] - x0[body])) > 1e-5 or np.max(np.abs(mat[body] - m0[body])) > 1e-5
            for xpos, mat, _, _, _ in shots
        ):
            moving.append(body)

    dynamic = []
    for gid in range(model.ngeom):
        if any(
            np.max(np.abs(pos[gid] - bind_pos[gid])) > 1e-6
            or np.max(np.abs(size[gid] - bind_size[gid])) > 1e-6
            or np.max(np.abs(rgba[gid] - bind_rgba[gid])) > 1e-4
            for _, _, pos, size, rgba in shots
        ):
            dynamic.append(gid)

    used = {}
    meshes = []
    geoms = []
    textures: list[dict] = []
    for gid in range(model.ngeom):
        if int(model.geom_group[gid]) >= 3:
            continue
        kind = _KIND.get(int(model.geom_type[gid]))
        if kind is None:
            continue
        mesh_index = None
        if kind == "mesh":
            src = int(model.geom_dataid[gid])
            if src < 0:
                continue
            mesh_index = used.get(src)
            if mesh_index is None:
                v0 = int(model.mesh_vertadr[src])
                vn = int(model.mesh_vertnum[src])
                f0 = int(model.mesh_faceadr[src])
                fn = int(model.mesh_facenum[src])
                entry = {
                    "positions": _nums(model.mesh_vert[v0 : v0 + vn].reshape(-1), 6),
                    "indices": [int(v) for v in model.mesh_face[f0 : f0 + fn].reshape(-1)],
                }
                uvn = int(model.mesh_texcoordnum[src])
                if uvn:
                    uv0 = int(model.mesh_texcoordadr[src])
                    entry["uv"] = _nums(model.mesh_texcoord[uv0 : uv0 + uvn].reshape(-1), 4)
                meshes.append(entry)
                mesh_index = used[src] = len(meshes) - 1
        matid = int(model.geom_matid[gid])
        rgba = model.mat_rgba[matid] if matid >= 0 else bind_rgba[gid]
        geoms.append(
            {
                "body": int(model.geom_bodyid[gid]),
                "gid": gid,
                "type": kind,
                "mesh": mesh_index,
                "size": _nums(bind_size[gid]),
                "pos": _nums(bind_pos[gid]),
                "quat": _nums(model.geom_quat[gid]),
                "rgba": _nums(rgba, 3),
                "tex": _texture_index(model, matid, textures),
                "emission": round(float(model.mat_emission[matid]), 3) if matid >= 0 else 0.0,
            }
        )

    frames = []
    for key, (xpos, xmat, pos, size, rgba) in zip(plan.keys, shots):
        frames.append(
            {
                "t": round(float(key.t), 4),
                "bodies": {
                str(body): _nums(np.concatenate([xpos[body], np.asarray(xmat[body]).reshape(-1)]))
                for body in moving
            },
                "dyn": [
                    _nums(list(pos[gid][:3]) + list(size[gid][:3]) + list(rgba[gid]), 4)
                    for gid in dynamic
                ],
            }
        )

    cid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_CAMERA, "overview")
    pos = np.asarray(scene.data.cam_xpos[cid], dtype=float)
    forward = -np.asarray(scene.data.cam_xmat[cid], dtype=float).reshape(3, 3)[:, 2]
    look = pos + forward * 2.4
    payload = {
        "camera": {"position": _nums(pos, 4), "target": _nums(look, 4)},
        "meshes": meshes,
        "textures": [{"file": item["file"]} for item in textures],
        "moving": moving,
        "dynamic": dynamic,
        "geoms": geoms,
        "frames": frames,
        "home": {
            str(body): _nums(np.concatenate([x0[body], np.asarray(m0[body]).reshape(-1)]))
            for body in range(model.nbody)
        },
    }
    path = folder / "view.json"
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    return path
