"""Validated VM resource defaults shared by provisioning tools, never environment overrides."""

import json
import math
import os
import pathlib
import stat

MAX_RESOURCE_BYTES = 4096
# VM tools and Windows provider parameters share the signed Int32 value domain.
MAX_RESOURCE_VALUE = 2147483647
RESOURCE_PATH = pathlib.Path('resources/config/computer.json')
RESOURCE_KEYS = frozenset(('cpu', 'memoryGB', 'diskGB'))
RANGE_KEYS = frozenset(('default', 'min', 'max'))
_UNSET = object()


def _identity(info):
    return info.st_dev, info.st_ino, info.st_nlink, info.st_size, info.st_mtime_ns


def _object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Invalid computer resource configuration')
        value[key] = item
    return value


def read_resources(path=None):
    path = pathlib.Path(path) if path is not None else pathlib.Path(__file__).resolve().parents[2] / RESOURCE_PATH
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_RESOURCE_BYTES:
        raise ValueError('Invalid computer resource file')
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    with os.fdopen(os.open(path, flags), 'rb') as stream:
        if _identity(os.fstat(stream.fileno())) != _identity(before):
            raise ValueError('Computer resource configuration changed')
        raw = stream.read(MAX_RESOURCE_BYTES + 1)
        if len(raw) > MAX_RESOURCE_BYTES or _identity(os.fstat(stream.fileno())) != _identity(before):
            raise ValueError('Computer resource configuration changed')
    after = path.lstat()
    if not stat.S_ISREG(after.st_mode) or _identity(after) != _identity(before):
        raise ValueError('Computer resource configuration changed')

    resources = json.loads(raw.decode('utf-8'), object_pairs_hook=_object)
    if not isinstance(resources, dict) or set(resources) != RESOURCE_KEYS:
        raise ValueError('Invalid computer resource configuration')
    for value in resources.values():
        if not isinstance(value, dict) or set(value) != RANGE_KEYS:
            raise ValueError('Invalid computer resource range')
        for key, item in value.items():
            if type(item) not in (int, float) or not 1 <= item <= MAX_RESOURCE_VALUE or not math.isfinite(item) or int(item) != item:
                raise ValueError('Invalid computer resource range')
            value[key] = int(item)
        if not value['min'] <= value['default'] <= value['max']:
            raise ValueError('Invalid computer resource range')
    return resources


def resource_value(resources, name, value=_UNSET):
    bounds = resources[name]
    value = bounds['default'] if value is _UNSET else value
    if type(value) is not int or not bounds['min'] <= value <= bounds['max']:
        raise ValueError('Invalid VM resource setting')
    return value
