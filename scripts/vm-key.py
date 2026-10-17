#!/usr/bin/env python3
"""Generate/validate dant's SSH machine key without PowerShell quoting rules."""
import argparse
import pathlib
import subprocess

COMMENT = "dant-local-vm"
LEGACY_PASSPHRASE = '""'


class KeyError(ValueError):
    pass


def keygen(*args):
    # Passing an argument array preserves empty strings on Windows. Do not
    # print ssh-keygen output: -y returns the public key and its comment.
    return subprocess.run(["ssh-keygen", *args], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                          timeout=30, check=False)


def public_parts(value):
    parts = value.strip().split(maxsplit=2)
    if len(parts) < 2 or parts[0] != "ssh-ed25519":
        raise KeyError("Expected an ed25519 SSH public key")
    return parts


def same_key(left, right):
    return public_parts(left)[:2] == public_parts(right)[:2]


def ensure_key(path):
    path = pathlib.Path(path).resolve()
    public_path = pathlib.Path(str(path) + ".pub")
    generated = False
    if not path.exists():
        if public_path.exists():
            raise KeyError("Orphan public key exists; no files were overwritten")
        path.parent.mkdir(parents=True, exist_ok=True)
        result = keygen("-q", "-t", "ed25519", "-f", str(path), "-N", "", "-C", COMMENT)
        if result.returncode:
            raise KeyError("SSH key generation failed (exit %s)" % result.returncode)
        generated = True
    if not path.is_file() or path.is_symlink():
        raise KeyError("SSH private key must be a regular file")
    existing_public = public_path.read_text(encoding="utf-8").strip() if public_path.exists() else None
    if existing_public is not None:
        public_parts(existing_public)
    result = keygen("-y", "-P", "", "-f", str(path))
    if result.returncode == 0:
        if existing_public and not same_key(result.stdout, existing_public):
            raise KeyError("Private/public SSH key mismatch; no key files were modified")
        if existing_public is None:
            public_parts(result.stdout)
            public_path.write_text(result.stdout.strip() + "\n", encoding="utf-8")
            return "recovered missing public key from validated private key"
        return "generated and validated" if generated else "validated (no passphrase)"

    # Only the accidentally encrypted machine key created by the old dant
    # PowerShell command may be repaired automatically. A custom encrypted
    # key, missing public key, foreign comment, or mismatch is never changed.
    if path.name != "vm-key" or not existing_public or public_parts(existing_public)[2:] != [COMMENT]:
        raise KeyError("Encrypted/unreadable SSH key is not an identifiable legacy dant machine key; unchanged")
    legacy = keygen("-y", "-P", LEGACY_PASSPHRASE, "-f", str(path))
    if legacy.returncode or not same_key(legacy.stdout, existing_public):
        raise KeyError("SSH key has an unknown passphrase or mismatched public key; unchanged")
    if public_parts(legacy.stdout)[2:] != [COMMENT]:
        raise KeyError("Private key comment is not the legacy dant project comment; unchanged")
    repaired = keygen("-p", "-P", LEGACY_PASSPHRASE, "-N", "", "-f", str(path))
    if repaired.returncode:
        raise KeyError("Legacy SSH passphrase repair failed (exit %s)" % repaired.returncode)
    verified = keygen("-y", "-P", "", "-f", str(path))
    if verified.returncode or not same_key(verified.stdout, existing_public):
        raise KeyError("Repaired SSH key did not pass public-key verification")
    if public_parts(verified.stdout)[2:] != public_parts(legacy.stdout)[2:]:
        raise KeyError("Repaired SSH key did not preserve its original comment")
    if public_path.read_text(encoding="utf-8").strip() != existing_public:
        raise KeyError("SSH public key file changed during repair")
    return "repaired legacy quoting passphrase (public key and comment preserved)"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=pathlib.Path)
    args = parser.parse_args()
    try:
        result = ensure_key(args.path)
    except (KeyError, OSError, subprocess.TimeoutExpired) as exc:
        raise SystemExit("SSH machine-key preparation failed: " + str(exc))
    print("SSH machine key: " + result)


if __name__ == "__main__":
    main()
