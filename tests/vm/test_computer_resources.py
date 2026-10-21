"""Canonical sizing resources, isolated files and no provisioning side effects."""

import copy
import importlib.util
import json
import os
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('computer_resources', ROOT / 'scripts/computer/resource-config.py')
resources = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(resources)
CANONICAL = json.loads((ROOT / 'resources/config/computer.json').read_bytes())


class ComputerResourceTests(unittest.TestCase):
    def test_defaults_and_explicit_values_use_only_the_validated_contract(self):
        self.assertEqual(resources.read_resources(), CANONICAL)
        self.assertEqual(resources.resource_value(CANONICAL, 'cpu'), 4)
        for field in CANONICAL:
            for value in (CANONICAL[field]['min'], CANONICAL[field]['max']):
                self.assertEqual(resources.resource_value(CANONICAL, field, value), value)
            for value in (None, False, True, '4', 1.5, CANONICAL[field]['min'] - 1, CANONICAL[field]['max'] + 1):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    resources.resource_value(CANONICAL, field, value)

    def test_schema_accepts_safe_mathematical_integers_and_exact_ranges_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / 'computer.json'
            valid = {name: {'default': 12.0, 'min': 12.0, 'max': 12.0} for name in CANONICAL}
            path.write_text(json.dumps(valid), encoding='utf-8')
            self.assertEqual(resources.read_resources(path), valid)
            maximum = {name: {key: resources.MAX_RESOURCE_VALUE for key in ('default', 'min', 'max')}
                       for name in CANONICAL}
            path.write_text(json.dumps(maximum), encoding='utf-8')
            self.assertEqual(resources.read_resources(path), maximum)
            path.write_text(json.dumps(valid).replace('12.0', '12e0'), encoding='utf-8')
            self.assertEqual(resources.read_resources(path), valid)

            invalid = [None, [], {}, {**CANONICAL, 'unexpected': True}]
            for value in (None, [], {}, {'default': 4, 'min': 1, 'max': 64, 'extra': 0},
                          {'default': 0, 'min': 1, 'max': 64}, {'default': 4, 'min': 5, 'max': 64},
                          {'default': 4, 'min': 1, 'max': 3}):
                invalid.append({**CANONICAL, 'cpu': value})
            for value in (True, False, None, '4', 0, -1, 1.5, float('nan'), float('inf'),
                          resources.MAX_RESOURCE_VALUE + 1, 9007199254740992, 10**600):
                config = copy.deepcopy(CANONICAL)
                config['cpu']['default'] = value
                invalid.append(config)
            for value in invalid:
                with self.subTest(value=value):
                    path.write_text(json.dumps(value), encoding='utf-8')
                    with self.assertRaises(ValueError):
                        resources.read_resources(path)
            duplicate = json.dumps(CANONICAL).replace('"cpu":', '"cpu":{},"cpu":', 1)
            for raw in (duplicate.encode(), b'{} trailing', b'\xef\xbb\xbf{}', b'\xff'):
                path.write_bytes(raw)
                with self.assertRaises(ValueError):
                    resources.read_resources(path)

    def test_missing_unsafe_oversized_and_changed_files_never_fall_back_to_defaults(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            helper = root / 'scripts/computer/resource-config.py'
            with patch.object(resources, '__file__', str(helper)), self.assertRaises(FileNotFoundError):
                resources.read_resources()
            path = root / resources.RESOURCE_PATH
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(CANONICAL))
            with patch.object(resources, '__file__', str(helper)):
                self.assertEqual(resources.read_resources(), CANONICAL)
            linked = root / 'hardlink'
            os.link(path, linked)
            with self.assertRaises(ValueError):
                resources.read_resources(path)
            linked.unlink()
            with self.assertRaises(ValueError):
                resources.read_resources(root)
            path.write_bytes(b'x' * (resources.MAX_RESOURCE_BYTES + 1))
            with self.assertRaises(ValueError):
                resources.read_resources(path)
            path.write_text(json.dumps(CANONICAL))
            before = path.stat()
            changed = types.SimpleNamespace(**{name: getattr(before, name) for name in
                ('st_dev', 'st_ino', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_mode')})
            changed.st_ino += 1
            for snapshots in ([changed], [before, changed]):
                with patch.object(resources.os, 'fstat', side_effect=snapshots), self.assertRaisesRegex(ValueError, 'changed'):
                    resources.read_resources(path)
            with patch.object(pathlib.Path, 'lstat', side_effect=[before, changed]), self.assertRaisesRegex(ValueError, 'changed'):
                resources.read_resources(path)


if __name__ == '__main__':
    unittest.main()
