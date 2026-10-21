"""Tests for the procedural rack-insert appearance mesh."""

from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path

import numpy as np

from sim.tube_rack_assets import write_insert


def read_obj(path: Path):
    verts, normals, faces = [], [], []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        fields = line.split()
        if not fields:
            continue
        if fields[0] == "v":
            value = [float(item) for item in fields[1:4]]
            if len(value) != 3 or not all(math.isfinite(item) for item in value):
                raise AssertionError(f"bad vertex on line {line_number}")
            verts.append(value)
        elif fields[0] == "vn":
            value = [float(item) for item in fields[1:4]]
            if len(value) != 3 or not all(math.isfinite(item) for item in value):
                raise AssertionError(f"bad normal on line {line_number}")
            normals.append(value)
        elif fields[0] == "f":
            if len(fields) != 4:
                raise AssertionError(f"non-triangle face on line {line_number}")
            face = []
            for token in fields[1:]:
                pieces = token.split("/")
                if len(pieces) != 3 or not pieces[0] or pieces[0] != pieces[2]:
                    raise AssertionError(f"bad face token {token!r} on line {line_number}")
                index = int(pieces[0])
                if index < 1 or index > len(verts):
                    raise AssertionError(f"out-of-range vertex index on line {line_number}")
                face.append(index)
            if len(set(face)) != 3:
                raise AssertionError(f"degenerate-index face on line {line_number}")
            faces.append(tuple(face))
    if not verts or not normals or not faces or len(verts) != len(normals):
        raise AssertionError("OBJ is empty or vertex/normal counts differ")
    return np.asarray(verts), np.asarray(normals), faces


def point_in_triangle(point, a, b, c, epsilon=1e-8) -> bool:
    px, py = point
    ax, ay = a[:2]
    bx, by = b[:2]
    cx, cy = c[:2]
    denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if abs(denominator) < 1e-16:
        return False
    u = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denominator
    v = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denominator
    w = 1.0 - u - v
    return min(u, v, w) >= -epsilon


def top_faces_at(vertices, faces, thickness):
    result = []
    for face in faces:
        triangle = vertices[np.asarray(face) - 1]
        if np.all(np.abs(triangle[:, 2] - thickness) <= 1e-7):
            result.append(triangle)
    return result


def covered(triangles, point) -> bool:
    return any(point_in_triangle(point, *triangle) for triangle in triangles)


def grid_openings(width, depth, columns=4, rows=6, radius=0.006):
    xs = [width * (column + 0.5) / columns for column in range(columns)]
    ys = [depth * (row + 0.5) / rows for row in range(rows)]
    return [(x, y, radius) for x in xs for y in ys]


class RackInsertTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def assert_mesh(self, path, width, depth, thickness):
        vertices, normals, faces = read_obj(path)
        self.assertGreater(len(faces), 0)
        self.assertTrue(np.all(np.isfinite(vertices)))
        self.assertTrue(np.all(np.isfinite(normals)))
        np.testing.assert_allclose(np.linalg.norm(normals, axis=1), 1.0, atol=1e-5)
        self.assertAlmostEqual(float(vertices[:, 0].min()), 0.0, delta=1e-6)
        self.assertAlmostEqual(float(vertices[:, 0].max()), width, delta=1e-6)
        self.assertAlmostEqual(float(vertices[:, 1].min()), 0.0, delta=1e-6)
        self.assertAlmostEqual(float(vertices[:, 1].max()), depth, delta=1e-6)
        self.assertAlmostEqual(float(vertices[:, 2].min()), 0.0, delta=1e-6)
        self.assertAlmostEqual(float(vertices[:, 2].max()), thickness, delta=1e-6)
        self.assertTrue(np.all(vertices[:, 0] >= -1e-7))
        self.assertTrue(np.all(vertices[:, 0] <= width + 1e-7))
        self.assertTrue(np.all(vertices[:, 1] >= -1e-7))
        self.assertTrue(np.all(vertices[:, 1] <= depth + 1e-7))
        self.assertTrue(np.all(vertices[:, 2] >= -1e-7))
        self.assertTrue(np.all(vertices[:, 2] <= thickness + 1e-7))
        for face in faces:
            triangle = vertices[np.asarray(face) - 1]
            if np.linalg.norm(np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])) <= 1e-14:
                raise AssertionError(f"zero-area face {face}")
        return vertices, faces, top_faces_at(vertices, faces, thickness)

    def assert_top_coverage(self, triangles, openings, width, depth):
        for hx, hy, radius in openings:
            samples = [(hx, hy)]
            for index in range(8):
                angle = 2.0 * math.pi * index / 8.0
                samples.append((hx + 0.8 * radius * math.cos(angle),
                                hy + 0.8 * radius * math.sin(angle)))
            for point in samples:
                self.assertFalse(covered(triangles, point),
                                 f"top face covers hole interior at {point}")

        columns = {}
        for hx, hy, radius in openings:
            columns.setdefault(hx, []).append((hy, radius))
        points = []
        for hx, column in columns.items():
            column.sort()
            if len(column) > 1:
                points.append((hx, (column[0][0] + column[1][0]) / 2.0))
        rows = {}
        for hx, hy, radius in openings:
            rows.setdefault(hy, []).append(hx)
        for hy, row in rows.items():
            row.sort()
            if len(row) > 1:
                points.append(((row[0] + row[1]) / 2.0, hy))
        points.append((width * 0.01, depth * 0.01))
        for point in points:
            self.assertTrue(covered(triangles, point),
                            f"top faces leave an inter-hole point uncovered at {point}")

    def test_regular_24_hole_insert_is_finite_and_open(self):
        path = self.folder / "regular.obj"
        width, depth, thickness = 0.090, 0.140, 0.005
        openings = grid_openings(width, depth)
        write_insert(path, width, depth, openings, thickness)
        vertices, faces, top = self.assert_mesh(path, width, depth, thickness)
        self.assertGreater(len(top), 0)
        self.assert_top_coverage(top, openings, width, depth)
        self.assertGreater(len(faces), 4 * 24)

    def test_irregular_6x15_and_4x50_hole_insert_is_finite_and_open(self):
        path = self.folder / "irregular.obj"
        width, depth, thickness = 0.180, 0.140, 0.006
        openings = [(x, y, 0.0075) for x in (0.018, 0.045, 0.072) for y in (0.035, 0.095)]
        openings += [(x, y, 0.015) for x in (0.115, 0.150) for y in (0.045, 0.095)]
        write_insert(path, width, depth, openings, thickness)
        vertices, faces, top = self.assert_mesh(path, width, depth, thickness)
        self.assertGreater(len(top), 0)
        self.assert_top_coverage(top, openings, width, depth)

    def test_invalid_dimensions_and_holes_raise_clear_value_errors(self):
        valid_openings = [(0.010, 0.010, 0.002)]
        for name, dimensions in (("width", (0.0, 0.02, 0.005)),
                                 ("depth", (0.02, -1.0, 0.005)),
                                 ("thickness", (0.02, 0.02, math.nan))):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, name):
                    write_insert(self.folder / f"bad-{name}.obj", dimensions[0], dimensions[1],
                                 valid_openings, dimensions[2])
        for hole in ((0.001, 0.010, 0.002), (0.010, 0.010, 0.0101),
                     (0.010, 0.010, -0.001), (math.inf, 0.010, 0.002)):
            with self.subTest(hole=hole):
                with self.assertRaisesRegex(ValueError, "hole|radius"):
                    write_insert(self.folder / "bad-hole.obj", 0.020, 0.020, [hole])


if __name__ == "__main__":
    unittest.main()
