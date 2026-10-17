"""VM setup guards and desktop input tests; no hypervisor or Linux required."""
import importlib.util
import base64
import hashlib
import io
import json
import os
import shutil
import pathlib
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


image = load("patch_image", "scripts/patch-image.py")
desktop = load("desktop", "vm/desktop.py")
vm_key = load("vm_key", "scripts/vm-key.py")


def fixture():
    """A small synthetic GPT/ext4 fixed VHD with the supported config layout."""
    data = bytearray(4 * 1024 * 1024 + 512)
    data[450] = 0xee
    data[510:512] = b"\x55\xaa"
    table = bytearray(128 * 128)
    table[:16] = image.LINUX_FS
    struct.pack_into("<QQ", table, 32, 2048, 8158)
    data[1024:1024 + len(table)] = table
    header = bytearray(512)
    header[:8] = b"EFI PART"
    struct.pack_into("<II", header, 8, 0x10000, 92)
    struct.pack_into("<QQQQ", header, 24, 1, 8191, 34, 8158)
    struct.pack_into("<QIII", header, 72, 2, 128, 128, zlib.crc32(table))
    struct.pack_into("<I", header, 16, zlib.crc32(header[:92]))
    data[512:1024] = header
    base = 2048 * 512
    struct.pack_into("<I", data, base + 1024 + 24, 2)
    struct.pack_into("<I", data, base + 1024 + 40, 16)
    data[base + 1024 + 56:base + 1024 + 58] = b"\x53\xef"
    struct.pack_into("<H", data, base + 1024 + 88, 256)
    struct.pack_into("<I", data, base + 1024 + 96, 0x40)
    struct.pack_into("<H", data, base + 1024 + 254, 64)
    struct.pack_into("<I", data, base + 4096 + 8, 2)
    names = [("etc", 3), ("cloud", 4), ("cloud.cfg.d", 5), ("90_dpkg.cfg", 6)]
    for number in range(2, 7):
        inode = base + 2 * 4096 + (number - 1) * 256
        block = number + 8
        is_file = number == 6
        payload = image.EXPECTED if is_file else None
        struct.pack_into("<H", data, inode, 0x8000 if is_file else 0x4000)
        struct.pack_into("<I", data, inode + 4, len(payload) if is_file else 4096)
        struct.pack_into("<I", data, inode + 32, 0x80000)
        struct.pack_into("<4H", data, inode + 40, 0xf30a, 1, 4, 0)
        struct.pack_into("<IHHI", data, inode + 52, 0, 1, 0, block)
        if not is_file:
            entries = [(".", number), ("..", max(2, number - 1)), names[number - 2]]
            payload = bytearray(4096)
            offset = 0
            for index, (name, child) in enumerate(entries):
                name = name.encode()
                size = (8 + len(name) + 3) // 4 * 4 if index < 2 else 4096 - offset
                struct.pack_into("<IHBB", payload, offset, child, size, len(name), 1)
                payload[offset + 8:offset + 8 + len(name)] = name
                offset += size
        start = base + block * 4096
        data[start:start + len(payload)] = payload
    footer = bytearray(512)
    footer[:8] = b"conectix"
    struct.pack_into(">I", footer, 12, 0x10000)
    struct.pack_into(">Q", footer, 48, len(data) - 512)
    struct.pack_into(">I", footer, 60, 2)
    struct.pack_into(">I", footer, 64, ~sum(footer) & 0xffffffff)
    data[-512:] = footer
    return data


class ImageTests(unittest.TestCase):
    def test_patch_writes_only_equal_length_config_bytes_and_preserves_audit(self):
        with tempfile.TemporaryDirectory() as folder:
            disk = pathlib.Path(folder) / "image.vhd"
            audit = pathlib.Path(folder) / "audit.json"
            original = fixture()
            disk.write_bytes(original)
            with disk.open("rb") as stream:
                content, offset, _ = image.Image(stream).locate()
            self.assertEqual(content, image.EXPECTED)
            result = subprocess.run([sys.executable, str(ROOT / "scripts/patch-image.py"), str(disk), "--apply", "--audit", str(audit)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            expected = original[:]
            expected[offset:offset + len(image.NEW)] = image.NEW
            self.assertEqual(disk.read_bytes(), expected)
            first_audit = audit.read_bytes()
            result = subprocess.run([sys.executable, str(ROOT / "scripts/patch-image.py"), str(disk), "--apply", "--audit", str(audit)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(audit.read_bytes(), first_audit)

    def test_invalid_vhd_is_rejected_without_writing(self):
        import io
        broken = fixture()
        broken[-512] = 0
        with self.assertRaises(image.ImageError):
            image.Image(io.BytesIO(broken))

    def test_unknown_configuration_is_rejected(self):
        import io
        broken = fixture()
        offset = broken.index(image.OLD)
        broken[offset:offset + len(image.OLD)] = b"x" * len(image.OLD)
        with self.assertRaises(image.ImageError):
            image.Image(io.BytesIO(broken)).locate()


class DesktopTests(unittest.TestCase):
    def test_drag_releases_button_when_movement_fails(self):
        calls = []

        def run(*args):
            calls.append(args)
            if "--sync" in args:
                raise RuntimeError("display disconnected")

        with patch.object(desktop, "run", run):
            with self.assertRaises(RuntimeError):
                desktop.act({"type": "drag", "startX": 12, "startY": 34, "endX": 300, "endY": 500, "button": 2})
        self.assertEqual(calls[1], ("xdotool", "mousedown", "3"))
        self.assertEqual(calls[-1], ("xdotool", "mouseup", "3"))


class SeedTests(unittest.TestCase):
    def test_public_key_with_slashes_produces_path_safe_instance_id(self):
        dependency = ROOT / ".tools/python"
        if dependency.exists():
            sys.path.insert(0, str(dependency))
        try:
            import pycdlib
        except ImportError:
            self.skipTest("pycdlib is installed by prepare-vm.ps1")
        encoded = base64.b64encode(struct.pack(">I", 11) + b"ssh-ed25519" + struct.pack(">I", 32) + b"\xff" * 32).decode()
        public = "ssh-ed25519 " + encoded + " dant-test"
        self.assertIn("/", encoded[-12:])
        with tempfile.TemporaryDirectory() as folder:
            data = pathlib.Path(folder) / "data"
            cache = pathlib.Path(folder) / "cache"
            data.mkdir()
            (data / "vm-key.pub").write_text(public)
            env = dict(os.environ)
            env["PYTHONPATH"] = str(dependency)
            command = [sys.executable, str(ROOT / "scripts/seed.py"), str(ROOT), "false",
                       "--data-directory", str(data), "--cache-directory", str(cache)]
            result = subprocess.run(command, env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            iso = pycdlib.PyCdlib()
            iso.open(str(cache / "seed.iso"))
            try:
                output = io.BytesIO()
                iso.get_file_from_iso_fp(output, joliet_path="/meta-data")
                identifier = json.loads(output.getvalue())["instance-id"]
                self.assertRegex(identifier, r"^dant-[0-9a-f]{20}$")
                self.assertEqual(identifier, "dant-" + hashlib.sha256(public.encode()).hexdigest()[:20])
                output = io.BytesIO()
                iso.get_file_from_iso_fp(output, joliet_path="/user-data")
                config = json.loads(output.getvalue().split(b"\n", 1)[1])
                self.assertEqual(config["users"][0]["ssh_authorized_keys"], [public])
                self.assertIsNone(config["users"][0]["sudo"])
            finally:
                iso.close()


@unittest.skipUnless(shutil.which("ssh-keygen"), "OpenSSH ssh-keygen is required")
class KeyTests(unittest.TestCase):
    def generate(self, path, passphrase, comment=vm_key.COMMENT):
        result = subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-f", str(path),
                                 "-N", passphrase, "-C", comment], capture_output=True)
        self.assertEqual(result.returncode, 0, "Test SSH key generation failed")

    def test_generate_and_revalidate_without_changing_key_or_comment(self):
        with tempfile.TemporaryDirectory(prefix="dant-key-test-", dir=ROOT) as folder:
            path = pathlib.Path(folder) / "vm-key"
            self.assertEqual(vm_key.ensure_key(path), "generated and validated")
            original = path.read_bytes()
            public = pathlib.Path(str(path) + ".pub").read_bytes()
            self.assertEqual(vm_key.ensure_key(path), "validated (no passphrase)")
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(pathlib.Path(str(path) + ".pub").read_bytes(), public)
            self.assertEqual(vm_key.public_parts(public.decode())[2], vm_key.COMMENT)

    def test_known_legacy_key_is_repaired_with_identical_public_key_and_comment(self):
        with tempfile.TemporaryDirectory(prefix="dant-key-test-", dir=ROOT) as folder:
            path = pathlib.Path(folder) / "vm-key"
            self.generate(path, vm_key.LEGACY_PASSPHRASE)
            public = pathlib.Path(str(path) + ".pub").read_bytes()
            self.assertIn("repaired legacy", vm_key.ensure_key(path))
            self.assertEqual(pathlib.Path(str(path) + ".pub").read_bytes(), public)
            self.assertEqual(vm_key.ensure_key(path), "validated (no passphrase)")

    def test_unknown_passphrase_foreign_comment_or_mismatched_public_key_are_unchanged(self):
        cases = [("user-chosen-passphrase", vm_key.COMMENT, False),
                 (vm_key.LEGACY_PASSPHRASE, "foreign-tool", False),
                 (vm_key.LEGACY_PASSPHRASE, vm_key.COMMENT, True)]
        for passphrase, comment, mismatch in cases:
            with self.subTest(comment=comment, mismatch=mismatch):
                with tempfile.TemporaryDirectory(prefix="dant-key-test-", dir=ROOT) as folder:
                    path = pathlib.Path(folder) / "vm-key"
                    self.generate(path, passphrase, comment)
                    public_path = pathlib.Path(str(path) + ".pub")
                    if mismatch:
                        parts = public_path.read_text().split(maxsplit=2)
                        parts[1] = "AAAA"
                        public_path.write_text(" ".join(parts) + "\n")
                    original, public = path.read_bytes(), public_path.read_bytes()
                    with self.assertRaises(vm_key.KeyError):
                        vm_key.ensure_key(path)
                    self.assertEqual(path.read_bytes(), original)
                    self.assertEqual(public_path.read_bytes(), public)


if __name__ == "__main__":
    unittest.main()
