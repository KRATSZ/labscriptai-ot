"""Select a digital runtime without mixing OT-2 and Flex model implementations."""
from dataclasses import dataclass
from typing import Callable


class RobotTypeError(ValueError):
    pass


def robot_type(raw: dict) -> str:
    if not isinstance(raw, dict):
        raise RobotTypeError("analysis must be a JSON object")
    declarations = [raw.get("robotType")]
    declarations += [raw[key].get("robotType") for key in ("metadata", "config") if isinstance(raw.get(key), dict)]
    aliases = {"ot-3 standard": "OT-3 Standard", "flex": "OT-3 Standard",
               "ot-2 standard": "OT-2 Standard", "ot-2": "OT-2 Standard"}
    kinds = set()
    for value in declarations:
        if value is None:
            continue
        if not isinstance(value, str) or value.strip().lower() not in aliases:
            raise RobotTypeError(f"unsupported robotType {value!r}; expected OT-2 or Flex")
        kinds.add(aliases[value.strip().lower()])
    if len(kinds) != 1:
        raise RobotTypeError("missing or conflicting robotType; analyze the protocol to identify OT-2 or Flex")
    return kinds.pop()


@dataclass(frozen=True)
class Machine:
    robot_type: str
    load_deck: Callable
    load_analysis: Callable
    plan: Callable
    scene_spec: Callable
    write_model: Callable
    scene: type
    renderer: type
    check_targets: Callable
    check_clearance: Callable
    check_liquid: Callable
    camera_pose: Callable
    protocol_error: type
    timed_geoms: bool = False

    def load_model(self, xml):
        if not self.timed_geoms:
            from sim.flex_scene import load_model
            return load_model(xml)
        import mujoco
        # Preserve Flex's Windows Unicode-path workaround for OT-2 too.
        assets = {item.name: item.read_bytes() for item in xml.parent.iterdir()
                  if item.is_file() and item.suffix.lower() in {".obj", ".stl", ".png"}}
        return mujoco.MjModel.from_xml_string(xml.read_text(encoding="utf-8"), assets)


def machine_for(kind: str) -> Machine:
    # Lazy imports keep structured unsupported/dependency failures available.
    if kind == "OT-2 Standard":
        from sim.ot2_runtime import ot2_protocol as p, ot2_scene as s, play_ot2_protocol as v
        from sim.ot2_runtime.flex_protocol import ProtocolError
        return Machine(kind, s.load_deck, p.load_analysis, p.plan, p.scene_spec,
                       s.write_spec_model, v.Scene, v.Renderer, v.check_targets,
                       v.check_clearance, v.check_liquid, s.deck_camera_pose, ProtocolError, True)
    if kind == "OT-3 Standard":
        from sim import flex_protocol as p, flex_scene as s, play_protocol as v
        return Machine(kind, s.load_deck, p.load_analysis, p.plan, p.scene_spec,
                       s.write_model, v.Scene, v.Renderer, v.check_targets,
                       v.check_clearance, v.check_liquid, s.deck_camera_pose, p.ProtocolError)
    raise RobotTypeError(f"unsupported robotType {kind!r}")
