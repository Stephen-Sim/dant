#!/usr/bin/env python3
"""Generate a real, validated WAV deliverable with the VM's local speech engine."""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import uuid
import wave

MAX_BYTES = 10 * 1024 * 1024

def create(text, output_dir, language=None):
    if not isinstance(text, str) or not text.strip() or len(text) > 2500:
        raise ValueError('Voice messages require 1–2500 text characters')
    if language not in (None, 'zh', 'en'):
        raise ValueError('Unsupported speech language')
    directory = pathlib.Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    if directory.is_symlink() or directory.absolute() != directory.resolve():
        raise ValueError('Voice output must use an ordinary output directory')
    binary = shutil.which('espeak-ng') or shutil.which('espeak')
    if not binary:
        raise RuntimeError('The VM local speech engine is not installed (espeak-ng)')
    voice = 'cmn' if (language == 'zh' or language is None and any('\u3400' <= char <= '\u9fff' for char in text)) else 'en'
    handle, filename = tempfile.mkstemp(prefix='voice-', suffix='.wav', dir=directory)
    os.close(handle)
    temporary = pathlib.Path(filename)
    try:
        subprocess.run([binary, '--stdin', '-v', voice, '-w', str(temporary)], input=text.encode('utf-8'), capture_output=True, check=True, timeout=45)
        if not temporary.is_file() or temporary.is_symlink() or not 44 < temporary.stat().st_size <= MAX_BYTES:
            raise ValueError('Speech output is missing or exceeds 10 MiB')
        with wave.open(str(temporary), 'rb') as audio:
            if audio.getcomptype() != 'NONE' or audio.getnchannels() not in (1, 2) or audio.getnframes() < 1 or audio.getframerate() < 8000:
                raise ValueError('Speech engine did not produce a valid PCM WAV')
        target = directory / ('voice-' + str(uuid.uuid4()) + '.wav')
        os.replace(temporary, target)
        return {'path': str(target), 'type': 'audio/wav', 'size': target.stat().st_size}
    finally:
        if temporary.exists():
            temporary.unlink()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(20001)
        if len(raw) > 20000:
            raise ValueError('Voice message input is too large')
        body = json.loads(raw)
        print(json.dumps(create(body.get('text'), args.output_dir, body.get('language'))))
    except Exception as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        sys.exit(1)
