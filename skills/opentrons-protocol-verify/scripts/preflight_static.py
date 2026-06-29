"""Static checks on protocol source text (no opentrons import required).

Use before `analyze` / `simulate` to catch common authoring mistakes early.

Regex-based checks cover pipette names and apiLevel hints. AST-based checks catch
``display_name`` length (keyword or first positional for ``add_*``), nonexistent
``default_flow_rate`` on the pipette object (heuristic), RTP mixed arg style, and
literal-list ``transfer`` shape (best-effort warnings).
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any


INVALID_FLEX_PIPETTE = re.compile(r"\b(flex_1channel_200|flex_8channel_200)\b")

# requirements = {"robotType": "Flex", "apiLevel": "2.xx"}
API_LEVEL_RE = re.compile(
    r"requirements\s*=\s*\{[^}]*[\"']apiLevel[\"']\s*:\s*[\"']([0-9.]+)[\"']",
    re.DOTALL,
)

PARAM_ADD_FUNCS = frozenset({"add_int", "add_float", "add_str", "add_bool"})


def _parse_api_level(text: str) -> tuple[int, int] | None:
    m = API_LEVEL_RE.search(text)
    if not m:
        return None
    parts = m.group(1).split(".")
    try:
        major = int(parts[0])
        minor = int(parts[1]) if len(parts) > 1 else 0
        return (major, minor)
    except (ValueError, IndexError):
        return None


def _display_name_literal_len(node: ast.expr) -> int | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return len(node.value)
    if isinstance(node, ast.JoinedStr):
        total = 0
        for part in node.values:
            if isinstance(part, ast.Constant) and isinstance(part.value, str):
                total += len(part.value)
            elif isinstance(part, ast.FormattedValue):
                return None
        return total
    return None


class _AstPreflightVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.errors: list[dict[str, Any]] = []
        self.warnings: list[dict[str, Any]] = []
        self.function_stack: list[str] = []
        self.dry_run_param_found = False
        self.return_tip_lines: list[int] = []
        self.drop_tip_outside_helper: list[int] = []
        self.auto_tip_calls: list[tuple[str, int]] = []

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.function_stack.append(node.name)
        self.generic_visit(node)
        self.function_stack.pop()

    def visit_Attribute(self, node: ast.Attribute) -> None:
        # Heuristic: InstrumentContext has no .default_flow_rate (use .flow_rate.aspirate / .dispense).
        if node.attr == "default_flow_rate":
            self.errors.append(
                {
                    "code": "nonexistent_default_flow_rate",
                    "message": (
                        "`InstrumentContext` has no `.default_flow_rate`. "
                        "Set `pipette.flow_rate.aspirate` / `pipette.flow_rate.dispense` (µL/s), "
                        "or save/restore those attributes."
                    ),
                    "line": node.lineno,
                }
            )
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr in PARAM_ADD_FUNCS:
            has_kw_display = any(kw.arg == "display_name" for kw in node.keywords)
            for kw in node.keywords:
                if kw.arg == "display_name" and kw.value is not None:
                    ln = _display_name_literal_len(kw.value)
                    if ln is not None and ln > 30:
                        self.errors.append(
                            {
                                "code": "display_name_too_long",
                                "message": (
                                    f"display_name length {ln} exceeds 30 characters "
                                    "(raises ParameterNameError at runtime)."
                                ),
                                "line": node.lineno,
                            }
                        )
            # First positional argument is display_name when using all-positional RTP style.
            if node.args and not has_kw_display:
                ln0 = _display_name_literal_len(node.args[0])
                if ln0 is not None and ln0 > 30:
                    self.errors.append(
                        {
                            "code": "display_name_too_long",
                            "message": (
                                f"display_name (positional) length {ln0} exceeds 30 characters "
                                "(raises ParameterNameError at runtime)."
                            ),
                            "line": node.lineno,
                        }
                    )
            if node.args and node.keywords:
                self.warnings.append(
                    {
                        "code": "mixed_positional_keyword_params",
                        "message": (
                            f"Prefer all-keyword arguments for `{func.attr}(...)` "
                            "(positional + keyword can raise TypeError)."
                        ),
                        "line": node.lineno,
                    }
                )

            if func.attr == "add_bool":
                variable_name: str | None = None
                default_value: bool | None = None
                for kw in node.keywords:
                    if (
                        kw.arg == "variable_name"
                        and isinstance(kw.value, ast.Constant)
                        and isinstance(kw.value.value, str)
                    ):
                        variable_name = kw.value.value
                    if (
                        kw.arg == "default"
                        and isinstance(kw.value, ast.Constant)
                        and isinstance(kw.value.value, bool)
                    ):
                        default_value = kw.value.value
                if variable_name == "dry_run_on":
                    self.dry_run_param_found = True
                    if default_value is not False:
                        self.errors.append(
                            {
                                "code": "dry_run_default_must_be_false",
                                "message": (
                                    "`dry_run_on` must explicitly use `default=False`; "
                                    "dry mode must never be enabled implicitly."
                                ),
                                "line": node.lineno,
                            }
                        )

        if isinstance(func, ast.Attribute) and func.attr == "return_tip":
            self.return_tip_lines.append(node.lineno)

        if isinstance(func, ast.Attribute) and func.attr == "drop_tip":
            current_function = self.function_stack[-1] if self.function_stack else ""
            if current_function != "finish_tip":
                self.drop_tip_outside_helper.append(node.lineno)

        if isinstance(func, ast.Attribute) and func.attr in {
            "transfer",
            "distribute",
            "consolidate",
            "transfer_with_liquid_class",
        }:
            new_tip_value: str | None = None
            for kw in node.keywords:
                if (
                    kw.arg == "new_tip"
                    and isinstance(kw.value, ast.Constant)
                    and isinstance(kw.value.value, str)
                ):
                    new_tip_value = kw.value.value
            if new_tip_value != "never":
                self.auto_tip_calls.append((func.attr, node.lineno))

        if isinstance(func, ast.Attribute) and func.attr == "transfer":
            if len(node.args) >= 3:
                src, dst = node.args[1], node.args[2]
                if isinstance(src, ast.List) and isinstance(dst, ast.List):
                    if len(src.elts) != len(dst.elts):
                        self.warnings.append(
                            {
                                "code": "transfer_length_mismatch_risk",
                                "message": (
                                    "transfer() source and destination list literals have "
                                    f"different lengths ({len(src.elts)} vs {len(dst.elts)}). "
                                    "Use matching lists or distribute()/consolidate()."
                                ),
                                "line": node.lineno,
                            }
                        )
        self.generic_visit(node)


def _analyze_ast(text: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        tree = ast.parse(text)
    except SyntaxError as exc:
        warn = [
            {
                "code": "syntax_error_unparsed_ast",
                "message": f"Could not parse protocol for AST checks: {exc.msg or exc}",
                "line": exc.lineno or 0,
            }
        ]
        return [], warn

    visitor = _AstPreflightVisitor()
    visitor.visit(tree)
    if visitor.dry_run_param_found:
        if not visitor.return_tip_lines:
            visitor.errors.append(
                {
                    "code": "dry_run_missing_return_tip",
                    "message": (
                        "`dry_run_on` is declared, but no `return_tip()` call exists. "
                        "Route tip release through `finish_tip()`."
                    ),
                    "line": 0,
                }
            )
        for line in visitor.drop_tip_outside_helper:
            visitor.errors.append(
                {
                    "code": "dry_run_bypassed_tip_helper",
                    "message": (
                        "`drop_tip()` bypasses `finish_tip()` while `dry_run_on` is declared; "
                        "this tip would not return to its pickup well."
                    ),
                    "line": line,
                }
            )
        for call_name, line in visitor.auto_tip_calls:
            visitor.errors.append(
                {
                    "code": "dry_run_automatic_tip_disposal",
                    "message": (
                        f"`{call_name}()` manages tips automatically. With `dry_run_on`, "
                        "use explicit pick/aspirate/dispense/finish_tip steps or set "
                        "`new_tip='never'` while managing the tip externally."
                    ),
                    "line": line,
                }
            )
    return visitor.errors, visitor.warnings


def analyze_protocol_text(text: str, source: str | None = None) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    for m in INVALID_FLEX_PIPETTE.finditer(text):
        line = text[: m.start()].count("\n") + 1
        errors.append(
            {
                "code": "invalid_flex_pipette_name",
                "message": (
                    f"Flex has no `{m.group(1)}`. Use flex_1channel_50 / flex_8channel_50 "
                    "or flex_1channel_1000 / flex_8channel_1000."
                ),
                "line": line,
            }
        )

    if "protocol.params" in text or re.search(r"\bprotocol\.params\b", text):
        ver = _parse_api_level(text)
        if ver is not None and ver < (2, 18):
            warnings.append(
                {
                    "code": "runtime_parameters_api_level",
                    "message": "protocol.params requires apiLevel >= 2.18 (use 2.20+ as baseline).",
                }
            )

    if "get_liquid_class" in text or "transfer_with_liquid_class" in text:
        ver = _parse_api_level(text)
        if ver is not None and ver < (2, 24):
            warnings.append(
                {
                    "code": "liquid_class_api_level",
                    "message": (
                        "Verified liquid classes require apiLevel >= 2.24 "
                        "(match opentrons.protocol_api.MAX_SUPPORTED_VERSION on your install)."
                    ),
                }
            )

    ast_errors, ast_warnings = _analyze_ast(text)
    errors.extend(ast_errors)
    warnings.extend(ast_warnings)

    return {
        "ok": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "source": source,
    }


def analyze_protocol_file(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8", errors="replace")
    return analyze_protocol_text(text, str(path.resolve()))
