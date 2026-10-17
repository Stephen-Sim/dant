#!/usr/bin/env python3
"""Recognize a bounded voice attachment locally; never write audio or transcripts."""
import argparse
import contextlib
import io
import json
import logging
import math
import os
import pathlib
import re
import sys

MAX_BYTES = 10 * 1024 * 1024
SAMPLE_RATE = 16000
MAX_SECONDS = 600
MAX_TEXT = 65536
MAX_RESULT_BYTES = 128 * 1024
MODEL_FILES = ('config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt')


class TranscriptionError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def read_audio(stream):
    data = stream.read(MAX_BYTES + 1)
    if not data or len(data) > MAX_BYTES:
        raise TranscriptionError('invalid_audio')
    return data


def local_model(directory):
    root = pathlib.Path(directory).absolute()
    if not root.is_dir() or root.is_symlink() or root != root.resolve():
        raise TranscriptionError('unavailable')
    for name in MODEL_FILES:
        file = root / name
        if file.is_symlink() or not file.is_file() or file.stat().st_size < 1:
            raise TranscriptionError('unavailable')
    return root


def decode_audio(data, av_module=None, numpy_module=None):
    if not data or len(data) > MAX_BYTES:
        raise TranscriptionError('invalid_audio')
    try:
        if av_module is None:
            import av as av_module
        if numpy_module is None:
            import numpy as numpy_module
    except ImportError:
        raise TranscriptionError('unavailable') from None
    np = numpy_module
    chunks, samples = [], 0
    try:
        # Custom in-memory IO needs no filesystem/network protocol. A malicious
        # playlist therefore cannot make the decoder fetch referenced resources.
        with av_module.open(io.BytesIO(data), mode='r', options={
            'protocol_whitelist': 'pipe', 'probesize': '1048576',
            'analyzeduration': '5000000', 'max_alloc': '67108864',
        }) as container:
            allowed = {'wav', 'mp3', 'ogg', 'matroska', 'webm', 'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'flac', 'aac'}
            if not allowed.intersection(container.format.name.split(',')) or not container.streams.audio:
                raise TranscriptionError('invalid_audio')
            if len(container.streams) > 8:
                raise TranscriptionError('invalid_audio')
            resampler = av_module.AudioResampler(format='fltp', layout='mono', rate=SAMPLE_RATE)

            def append(frames):
                nonlocal samples
                for frame in frames:
                    samples += frame.samples
                    if samples > MAX_SECONDS * SAMPLE_RATE:
                        raise TranscriptionError('too_long')
                    if frame.samples:
                        chunks.append(np.frombuffer(frame.planes[0], dtype=np.float32, count=frame.samples).copy())

            for frame in container.decode(audio=0):
                append(resampler.resample(frame))
            append(resampler.resample(None))
    except TranscriptionError:
        raise
    except Exception:
        raise TranscriptionError('invalid_audio') from None
    if not samples:
        raise TranscriptionError('no_speech')
    audio = np.concatenate(chunks)
    if not np.isfinite(audio).all():
        raise TranscriptionError('invalid_audio')
    if float(np.max(np.abs(audio))) <= 0.00001:
        raise TranscriptionError('no_speech')
    return audio, samples / SAMPLE_RATE


def transcribe(data, model_dir, decoder=decode_audio, model_factory=None):
    audio, duration = decoder(data)
    if not math.isfinite(duration) or duration <= 0:
        raise TranscriptionError('invalid_audio')
    if duration > MAX_SECONDS:
        raise TranscriptionError('too_long')
    root = local_model(model_dir)
    if model_factory is None:
        try:
            from faster_whisper import WhisperModel
            model_factory = WhisperModel
        except ImportError:
            raise TranscriptionError('unavailable') from None
    try:
        model = model_factory(str(root), device='cpu', compute_type='int8',
                              cpu_threads=2, num_workers=1, local_files_only=True)
        segments, info = model.transcribe(audio, language=None, task='transcribe',
                                          vad_filter=True, condition_on_previous_text=False,
                                          beam_size=5, log_progress=False)
        text, size = [], 0
        for segment in segments:
            part = segment.text.strip()
            if not part:
                continue
            size += len(part) + bool(text)
            if size > MAX_TEXT:
                raise TranscriptionError('failed')
            text.append(part)
        if not text:
            raise TranscriptionError('no_speech')
        language = info.language
        if not isinstance(language, str) or not re.fullmatch('[a-z]{2,3}', language):
            raise TranscriptionError('failed')
        result = {'text': ' '.join(text), 'language': language, 'duration': duration}
        if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > MAX_RESULT_BYTES:
            raise TranscriptionError('failed')
        return result
    except TranscriptionError:
        raise
    except Exception:
        raise TranscriptionError('failed') from None


def resource_limits():
    for name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
        os.environ[name] = '2'
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    logging.disable(logging.CRITICAL)
    if sys.platform.startswith('linux'):
        import resource
        for resource_id, limit in ((resource.RLIMIT_CORE, 0), (resource.RLIMIT_FSIZE, 0),
                                   (resource.RLIMIT_AS, 4 * 1024 ** 3), (resource.RLIMIT_CPU, 600)):
            soft, hard = resource.getrlimit(resource_id)
            resource.setrlimit(resource_id, (min(limit, hard) if hard != resource.RLIM_INFINITY else limit, hard))


@contextlib.contextmanager
def quiet_dependencies():
    # Native codec/model libraries can write directly to stdout/stderr. Keep the
    # subprocess protocol and diagnostics free of filenames, audio and text.
    saved = [os.dup(1), os.dup(2)]
    try:
        with open(os.devnull, 'w') as sink:
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
            try:
                yield
            finally:
                sys.stdout.flush()
                sys.stderr.flush()
    finally:
        for target, original in zip((1, 2), saved):
            os.dup2(original, target)
            os.close(original)


def main():
    try:
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, 'reconfigure'):
                stream.reconfigure(encoding='utf-8')
        parser = argparse.ArgumentParser()
        parser.add_argument('--model-dir', required=True)
        args = parser.parse_args()
        resource_limits()
        data = read_audio(sys.stdin.buffer)
        with quiet_dependencies():
            result = transcribe(data, args.model_dir)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        code = error.code if isinstance(error, TranscriptionError) else 'failed'
        print(json.dumps({'error': code}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
