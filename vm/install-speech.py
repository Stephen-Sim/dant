#!/usr/bin/env python3
"""Install the pinned local Ubuntu speech packages."""

import hashlib, json, pathlib, shlex, subprocess, sys, urllib.parse


def install(root):
    downloads = root / 'downloads'
    downloads.mkdir(exist_ok=True)
    # Ubuntu 24.04's signed apt metadata supplies both the origin and exact hash.
    # Keep this deliberately narrow: no installer scripts, sudo, or system writes.
    packages = {
        'espeak-ng': '1.51+dfsg-12build1',
        'libespeak-ng1': '1.51+dfsg-12build1',
        'espeak-ng-data': '1.51+dfsg-12build1',
        'libpcaudio0': '1.2-2build3',
        'libsonic0': '0.2.0-13build1',
    }
    manifest = []
    for name, version in packages.items():
        specification = name + '=' + version
        output = subprocess.run(['apt-get', '--print-uris', 'download', specification], capture_output=True, text=True, check=True).stdout
        lines = [shlex.split(line) for line in output.splitlines() if line.startswith("'http")]
        assert len(lines) == 1 and len(lines[0]) == 4, 'Cannot resolve pinned Ubuntu package'
        uri, filename, size, checksum = lines[0]
        host = urllib.parse.urlparse(uri).hostname
        assert host == 'archive.ubuntu.com' or host.endswith('.ubuntu.com'), 'Unexpected package origin'
        assert pathlib.Path(filename).name == filename and filename.endswith('.deb'), 'Unexpected package filename'
        metadata = subprocess.run(['apt-cache', 'show', specification], capture_output=True, text=True, check=True).stdout
        digests = {line.removeprefix('SHA256:').strip() for line in metadata.splitlines() if line.startswith('SHA256:')}
        assert len(digests) == 1, 'Expected unambiguous authenticated SHA-256 metadata'
        digest = digests.pop()
        assert len(digest) == 64 and all(character in '0123456789abcdef' for character in digest), 'Invalid SHA-256 metadata'
        subprocess.run(['apt-get', 'download', specification], cwd=downloads, check=True)
        archive = downloads / filename
        with archive.open('rb') as stream:
            assert hashlib.file_digest(stream, 'sha256').hexdigest() == digest, 'Ubuntu package checksum mismatch'
        assert archive.stat().st_size == int(size), 'Ubuntu package size mismatch'
        subprocess.run(['dpkg-deb', '-x', str(archive), str(root)], check=True)
        manifest.append({'package': name, 'version': version, 'source': uri, 'sha256': digest, 'bytes': int(size)})
    (root / 'deployment.json').write_text(json.dumps({'source': 'Ubuntu 24.04 signed apt metadata', 'packages': manifest}, indent=2))


if __name__ == "__main__":
    install(pathlib.Path(sys.argv[1]))
