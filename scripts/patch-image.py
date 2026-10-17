#!/usr/bin/env python3
"""Inspect/patch NoCloud configuration in an unattached Ubuntu fixed VHD.

This deliberately supports only the official GPT/ext4 Azure image used by dant.
It never mounts a filesystem, changes metadata, or grows a file. Unknown layouts
fail closed. The caller must ensure the disk is not attached to any VM.
"""
import argparse
import hashlib
import json
import os
import pathlib
import struct
import uuid
import zlib


OLD = b"datasource_list: [ Azure ]"
NEW = b"datasource_list: [NoCloud]"
CONFIG = "/etc/cloud/cloud.cfg.d/90_dpkg.cfg"
EXPECTED = b"# to update this file, run dpkg-reconfigure cloud-init\n" + OLD + b"\n"
LINUX_FS = uuid.UUID("0fc63daf-8483-4772-8e79-3d69d8477de4").bytes_le


class ImageError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ImageError(message)


class Image:
    def __init__(self, stream):
        self.stream = stream
        stream.seek(0, 2)
        self.file_size = stream.tell()
        require(self.file_size >= 1024 * 1024, "Image is too small")
        footer = self.read(self.file_size - 512, 512)
        require(footer[:8] == b"conectix", "Not a VHD image")
        require(struct.unpack_from(">I", footer, 12)[0] == 0x10000, "Unknown VHD version")
        require(struct.unpack_from(">I", footer, 60)[0] == 2, "Only fixed VHD images are supported")
        self.disk_size = struct.unpack_from(">Q", footer, 48)[0]
        require(self.disk_size == self.file_size - 512, "VHD size/footer mismatch")
        clean = bytearray(footer)
        clean[64:68] = b"\0" * 4
        require((~sum(clean) & 0xffffffff) == struct.unpack_from(">I", footer, 64)[0], "Invalid VHD footer checksum")
        self.footer_hash = hashlib.sha256(footer).hexdigest()
        mbr = self.read(0, 512)
        require(mbr[510:] == b"\x55\xaa" and mbr[450] == 0xee, "Expected a protective GPT MBR")
        header = self.read(512, 512)
        require(header[:8] == b"EFI PART", "GPT header missing")
        require(struct.unpack_from("<I", header, 8)[0] == 0x10000, "Unknown GPT version")
        header_size = struct.unpack_from("<I", header, 12)[0]
        require(92 <= header_size <= 512, "Invalid GPT header length")
        check_header = bytearray(header[:header_size])
        check_header[16:20] = b"\0" * 4
        require(zlib.crc32(check_header) == struct.unpack_from("<I", header, 16)[0], "Invalid GPT header checksum")
        require(struct.unpack_from("<Q", header, 24)[0] == 1, "Unexpected GPT header location")
        first_usable, last_usable = struct.unpack_from("<QQ", header, 40)
        lba, count, entry_size, checksum = struct.unpack_from("<QIII", header, 72)
        require(lba == 2 and count == 128 and entry_size == 128, "Unsupported GPT entry layout")
        entries = self.read(lba * 512, count * entry_size)
        require(zlib.crc32(entries) == checksum, "Invalid GPT partition table checksum")
        roots = []
        for index in range(count):
            entry = entries[index * entry_size:(index + 1) * entry_size]
            if entry[:16] == LINUX_FS:
                first, last = struct.unpack_from("<QQ", entry, 32)
                require(first_usable <= first <= last <= last_usable, "Invalid Linux partition range")
                require((last + 1) * 512 <= self.disk_size, "Linux partition exceeds VHD")
                roots.append((first * 512, (last - first + 1) * 512))
        require(len(roots) == 1, "Expected exactly one Linux filesystem partition")
        self.base, self.partition_size = roots[0]
        sb = self.part_read(1024, 1024)
        require(sb[56:58] == b"\x53\xef", "Expected ext4 filesystem")
        self.block_size = 1024 << struct.unpack_from("<I", sb, 24)[0]
        self.inodes_per_group = struct.unpack_from("<I", sb, 40)[0]
        self.inode_size = struct.unpack_from("<H", sb, 88)[0]
        self.descriptor_size = struct.unpack_from("<H", sb, 254)[0] or 32
        require(self.block_size == 4096 and self.inode_size == 256 and self.descriptor_size == 64,
                "Unsupported ext4 block/inode/descriptor layout")
        require(self.inodes_per_group > 0, "Invalid ext4 inode group size")
        require(struct.unpack_from("<I", sb, 96)[0] & 0x40, "ext4 extents are required")

    def read(self, offset, length):
        require(0 <= offset <= self.file_size and 0 <= length <= self.file_size - offset, "Read exceeds VHD")
        self.stream.seek(offset)
        result = self.stream.read(length)
        require(len(result) == length, "Incomplete VHD read")
        return result

    def part_read(self, offset, length):
        require(0 <= offset <= self.partition_size and 0 <= length <= self.partition_size - offset,
                "Read exceeds ext4 partition")
        return self.read(self.base + offset, length)

    def inode(self, number):
        require(number > 0, "Invalid inode number")
        group, index = divmod(number - 1, self.inodes_per_group)
        desc = self.part_read(self.block_size + group * self.descriptor_size, self.descriptor_size)
        table = struct.unpack_from("<I", desc, 8)[0] | (struct.unpack_from("<I", desc, 40)[0] << 32)
        return self.part_read(table * self.block_size + index * self.inode_size, self.inode_size)

    def extents(self, header, expected_depth=None):
        require(len(header) >= 12, "Incomplete extent header")
        magic, count, capacity, depth = struct.unpack_from("<4H", header)
        require(magic == 0xf30a and count <= capacity <= (len(header) - 12) // 12 and depth <= 5,
                "Unsupported or invalid ext4 extent tree")
        if expected_depth is not None:
            require(depth == expected_depth, "Inconsistent extent tree depth")
        for index in range(count):
            record = header[12 + index * 12:24 + index * 12]
            logical = struct.unpack_from("<I", record)[0]
            if depth:
                child = struct.unpack_from("<I", record, 4)[0] | (struct.unpack_from("<H", record, 8)[0] << 32)
                yield from self.extents(self.part_read(child * self.block_size, self.block_size), depth - 1)
            else:
                length, high, low = struct.unpack_from("<HHI", record, 4)
                require(0 < length <= 32768, "Unwritten or invalid ext4 extent")
                yield logical, (high << 32) | low, length

    def file(self, number):
        inode = self.inode(number)
        mode = struct.unpack_from("<H", inode)[0] & 0xf000
        require(mode in (0x4000, 0x8000), "Only directories and regular files are supported")
        require(struct.unpack_from("<I", inode, 32)[0] & 0x80000, "Inode does not use extents")
        size = struct.unpack_from("<I", inode, 4)[0] | (struct.unpack_from("<I", inode, 108)[0] << 32)
        require(size <= 4 * 1024 * 1024, "Unexpectedly large configuration/directory")
        result = bytearray(size)
        locations = []
        covered = 0
        for logical, physical, length in self.extents(inode[40:100]):
            start = logical * self.block_size
            require(start == covered and start < size, "Sparse/overlapping extent layout is unsupported")
            length = min(length * self.block_size, size - start)
            result[start:start + length] = self.part_read(physical * self.block_size, length)
            locations.append((start, self.base + physical * self.block_size, length))
            covered += length
        require(covered == size, "Incomplete extent coverage")
        return bytes(result), locations, mode

    def directory(self, number):
        data, _, mode = self.file(number)
        require(mode == 0x4000, "Path component is not a directory")
        entries = {}
        offset = 0
        while offset + 8 <= len(data):
            inode, size, name_size, _ = struct.unpack_from("<IHBB", data, offset)
            require(size >= 8 and size % 4 == 0 and offset + size <= len(data) and name_size <= size - 8,
                    "Invalid ext4 directory entry")
            if inode:
                name = data[offset + 8:offset + 8 + name_size].decode("utf-8")
                require(name not in entries, "Duplicate ext4 directory entry")
                entries[name] = inode
            offset += size
        return entries

    def locate(self):
        number = 2
        for component in CONFIG.strip("/").split("/"):
            entries = self.directory(number)
            require(component in entries, "Expected cloud-init config path is missing")
            number = entries[component]
        data, locations, mode = self.file(number)
        require(mode == 0x8000 and len(locations) == 1, "Config must be a regular file in one extent")
        require(data in (EXPECTED, EXPECTED.replace(OLD, NEW)), "Unknown cloud-init configuration contents")
        index = data.find(OLD if OLD in data else NEW)
        return data, locations[0][1] + index, number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=pathlib.Path)
    parser.add_argument("--apply", action="store_true", help="Patch an unattached pristine fixed VHD")
    parser.add_argument("--audit", type=pathlib.Path, help="Create audit JSON before writing disk bytes")
    args = parser.parse_args()
    require(args.image.suffix.lower() == ".vhd", "Only .vhd files may be inspected/patched")
    require(not args.apply or args.audit, "--apply requires an audit path")
    with args.image.open("r+b" if args.apply else "rb") as stream:
        image = Image(stream)
        content, offset, inode = image.locate()
        info = {"image": str(args.image.resolve()), "config": CONFIG, "inode": inode,
                "offset": offset, "footerSha256": image.footer_hash,
                "originalHex": OLD.hex(), "replacementHex": NEW.hex(),
                "state": "already-patched" if NEW in content else "pristine"}
        if args.apply and args.audit.exists():
            audit = json.loads(args.audit.read_text(encoding="utf-8"))
            require(all(audit.get(key) == value for key, value in info.items() if key != "state"),
                    "Existing patch audit does not match this image/configuration")
        elif args.apply:
            require(OLD in content, "Already-patched image has no matching original audit")
        if args.apply and OLD in content:
            args.audit.parent.mkdir(parents=True, exist_ok=True)
            # Exclusive creation preserves the original audit across retries.
            if not args.audit.exists():
                with args.audit.open("x", encoding="utf-8") as log:
                    json.dump(info, log, indent=2)
                    log.flush()
                    os.fsync(log.fileno())
            require(image.read(offset, len(OLD)) == OLD, "Config changed after inspection")
            stream.seek(offset)
            stream.write(NEW)
            stream.flush()
            os.fsync(stream.fileno())
            require(image.read(offset, len(NEW)) == NEW, "Config patch verification failed")
            require(image.locate()[0] == EXPECTED.replace(OLD, NEW), "Patched config could not be read back")
            info["state"] = "patched"
        print(json.dumps(info))


if __name__ == "__main__":
    try:
        main()
    except (ImageError, OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SystemExit("VHD configuration patch refused: " + str(exc))
