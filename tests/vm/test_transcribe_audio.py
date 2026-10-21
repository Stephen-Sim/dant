"""Local audio validation with synthetic codec/model boundaries, never real audio/model IO."""
import contextlib
import importlib.util
import io
import json
import math
import os
import pathlib
import runpy
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('transcription_test', ROOT / 'vm/transcribe_audio.py')
audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio)


class Samples(list):
    def copy(self):
        return Samples(self)


class Numbers:
    float32 = 'float32'

    def frombuffer(self, value, dtype, count):
        if dtype != self.float32:
            raise AssertionError('Only bounded float32 is expected')
        return Samples(struct.unpack('<' + 'f' * count, value))

    def concatenate(self, chunks):
        return Samples(value for chunk in chunks for value in chunk)

    def isfinite(self, values):
        return types.SimpleNamespace(all=lambda: all(math.isfinite(value) for value in values))

    def abs(self, values):
        return [abs(value) for value in values]

    def max(self, values):
        return max(values)


def frame(values):
    return types.SimpleNamespace(samples=len(values), planes=[struct.pack('<' + 'f' * len(values), *values)])


class Codec:
    def __init__(self, values=(0.25, -0.25), format_name='wav', streams=1):
        self.frames = [frame(values)]
        self.format_name = format_name
        self.streams = [object() for _ in range(streams)]
        self.opened = []
        self.resampler_options = []
        self.failure = None

    @contextlib.contextmanager
    def open(self, source, **options):
        if not isinstance(source, io.BytesIO):
            raise AssertionError('The decoder must never receive a filename or URL')
        self.opened.append((source.getvalue(), options))
        if self.failure:
            raise self.failure
        class Streams(list):
            audio = self.streams
        yield types.SimpleNamespace(format=types.SimpleNamespace(name=self.format_name),
            streams=Streams(self.streams), decode=lambda **_: iter(self.frames))

    def AudioResampler(self, **options):
        self.resampler_options.append(options)
        return types.SimpleNamespace(resample=lambda value: [] if value is None else [value])


class TranscriptionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.model = pathlib.Path(self.temporary.name).resolve()
        for name in audio.MODEL_FILES:
            (self.model / name).write_bytes(b'isolated model marker')

    def assert_code(self, code, callback):
        with self.assertRaises(audio.TranscriptionError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), code)

    def decoder(self, data):
        self.assertEqual(data, b'voice')
        return Samples([0.25]), 0.5

    def model_factory(self, parts, language='zh', error=None):
        def factory(directory, **options):
            self.assertEqual(directory, str(self.model))
            self.assertEqual(options, {'device': 'cpu', 'compute_type': 'int8', 'cpu_threads': 2,
                'num_workers': 1, 'local_files_only': True})
            def transcribe(samples, **parameters):
                self.assertEqual(samples, [0.25])
                self.assertEqual(parameters, {'language': None, 'task': 'transcribe', 'vad_filter': True,
                    'condition_on_previous_text': False, 'beam_size': 5, 'log_progress': False})
                if error:
                    raise error
                return (types.SimpleNamespace(text=value) for value in parts), types.SimpleNamespace(language=language)
            return types.SimpleNamespace(transcribe=transcribe)
        return factory

    def test_read_audio_bounds_and_model_requires_complete_ordinary_files(self):
        self.assertEqual(audio.read_audio(io.BytesIO(b'voice')), b'voice')
        self.assertEqual(audio.local_model(self.model), self.model)
        self.assert_code('invalid_audio', lambda: audio.read_audio(io.BytesIO()))
        self.assert_code('invalid_audio', lambda: audio.read_audio(io.BytesIO(b'x' * (audio.MAX_BYTES + 1))))
        self.assert_code('unavailable', lambda: audio.local_model(self.model / 'missing'))
        for name in audio.MODEL_FILES:
            path = self.model / name
            original = path.read_bytes()
            path.write_bytes(b'')
            self.assert_code('unavailable', lambda: audio.local_model(self.model))
            path.write_bytes(original)

    def test_decoder_uses_only_memory_protocol_and_bounded_mono_resampling(self):
        codec = Codec()
        values, duration = audio.decode_audio(b'voice', codec, Numbers())
        self.assertEqual(values, [0.25, -0.25])
        self.assertEqual(duration, 2 / audio.SAMPLE_RATE)
        self.assertEqual(codec.opened, [(b'voice', {'mode': 'r', 'options': {'protocol_whitelist': 'pipe',
            'probesize': '1048576', 'analyzeduration': '5000000', 'max_alloc': '67108864'}})])
        self.assertEqual(codec.resampler_options, [{'format': 'fltp', 'layout': 'mono', 'rate': 16000}])
        with patch.dict(sys.modules, av=Codec(), numpy=Numbers()):
            self.assertEqual(audio.decode_audio(b'voice')[0], values)

    def test_decoder_rejects_missing_dependencies_untrusted_formats_and_invalid_samples(self):
        for data in (b'', b'x' * (audio.MAX_BYTES + 1)):
            self.assert_code('invalid_audio', lambda: audio.decode_audio(data, Codec(), Numbers()))
        with patch.dict(sys.modules, av=None):
            self.assert_code('unavailable', lambda: audio.decode_audio(b'voice'))
        with patch.dict(sys.modules, numpy=None):
            self.assert_code('unavailable', lambda: audio.decode_audio(b'voice', Codec()))
        for codec, code in ((Codec(format_name='hls'), 'invalid_audio'), (Codec(streams=0), 'invalid_audio'),
                (Codec(streams=9), 'invalid_audio'), (Codec(values=()), 'no_speech'),
                (Codec(values=(0.0,)), 'no_speech'), (Codec(values=(float('nan'),)), 'invalid_audio')):
            with self.subTest(code=code, format=codec.format_name):
                self.assert_code(code, lambda: audio.decode_audio(b'voice', codec, Numbers()))
        codec = Codec()
        codec.failure = RuntimeError('private filename sentinel')
        self.assert_code('invalid_audio', lambda: audio.decode_audio(b'voice', codec, Numbers()))
        codec = Codec()
        codec.frames = [types.SimpleNamespace(samples=audio.MAX_SECONDS * audio.SAMPLE_RATE + 1)]
        self.assert_code('too_long', lambda: audio.decode_audio(b'voice', codec, Numbers()))

    def test_transcription_is_local_only_and_preserves_recognized_text(self):
        result = audio.transcribe(b'voice', self.model, self.decoder, self.model_factory(['  你好  ', '', 'world']))
        self.assertEqual(result, {'text': '你好 world', 'language': 'zh', 'duration': 0.5})
        with patch.dict(sys.modules, faster_whisper=types.SimpleNamespace(WhisperModel=self.model_factory(['hello'], 'en'))):
            self.assertEqual(audio.transcribe(b'voice', self.model, self.decoder)['text'], 'hello')
        with patch.dict(sys.modules, faster_whisper=None):
            self.assert_code('unavailable', lambda: audio.transcribe(b'voice', self.model, self.decoder))

    def test_duration_language_text_and_dependency_failures_remain_fixed_errors(self):
        for duration, code in ((float('nan'), 'invalid_audio'), (0, 'invalid_audio'),
                (-1, 'invalid_audio'), (601, 'too_long')):
            self.assert_code(code, lambda: audio.transcribe(b'voice', self.model,
                lambda _: ([], duration), self.model_factory(['unused'])))
        for parts, language, error, code in ((['  '], 'en', None, 'no_speech'),
                (['x' * (audio.MAX_TEXT + 1)], 'en', None, 'failed'),
                (['hello'], 'private-locale', None, 'failed'), (['hello'], None, None, 'failed'),
                (['hello'], 'en', RuntimeError('private transcript sentinel'), 'failed')):
            with self.subTest(code=code, language=language):
                self.assert_code(code, lambda: audio.transcribe(b'voice', self.model, self.decoder,
                    self.model_factory(parts, language, error)))
        self.assert_code('failed', lambda: audio.transcribe(b'voice', self.model, self.decoder,
            self.model_factory(['界' * (audio.MAX_RESULT_BYTES // 3)], 'zh')))

    def test_resource_policy_caps_threads_offline_flags_and_linux_limits_without_real_mutations(self):
        resource = types.SimpleNamespace(RLIMIT_CORE=1, RLIMIT_FSIZE=2, RLIMIT_AS=3, RLIMIT_CPU=4,
            RLIM_INFINITY=-1, getrlimit=Mock(side_effect=[(10, -1), (10, 5), (10, -1), (10, 300)]),
            setrlimit=Mock())
        with patch.dict(os.environ, {}, clear=True), patch.dict(sys.modules, resource=resource), \
                patch.object(audio.sys, 'platform', 'linux'), patch.object(audio.logging, 'disable') as disable:
            audio.resource_limits()
            self.assertEqual(os.environ['HF_HUB_OFFLINE'], '1')
            self.assertEqual(os.environ['TRANSFORMERS_OFFLINE'], '1')
            self.assertEqual(os.environ['TOKENIZERS_PARALLELISM'], 'false')
            self.assertTrue(all(os.environ[key] == '2' for key in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS',
                'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS')))
            self.assertEqual([call.args for call in resource.setrlimit.call_args_list],
                [(1, (0, -1)), (2, (0, 5)), (3, (4 * 1024 ** 3, -1)), (4, (300, 300))])
            disable.assert_called_once_with(audio.logging.CRITICAL)

    def test_quiet_dependencies_restores_owned_descriptors_even_when_decoder_fails(self):
        sink = Mock()
        sink.fileno.return_value = 20
        with patch.object(audio.os, 'dup', side_effect=[11, 12]), patch.object(audio.os, 'dup2') as duplicate, \
                patch.object(audio.os, 'close') as close, patch('builtins.open', return_value=contextlib.nullcontext(sink)), \
                patch.object(audio.sys, 'stdout') as stdout, patch.object(audio.sys, 'stderr') as stderr:
            with self.assertRaisesRegex(RuntimeError, 'isolated'):
                with audio.quiet_dependencies():
                    raise RuntimeError('isolated')
            self.assertEqual([call.args for call in duplicate.call_args_list], [(20, 1), (20, 2), (11, 1), (12, 2)])
            self.assertEqual([call.args for call in close.call_args_list], [(11,), (12,)])
            stdout.flush.assert_called_once()
            stderr.flush.assert_called_once()

    def test_cli_prints_only_result_or_fixed_error_and_never_raw_dependency_content(self):
        for failure, expected in ((None, None), (audio.TranscriptionError('no_speech'), 'no_speech'),
                (RuntimeError('private transcript sentinel'), 'failed')):
            output, errors = io.StringIO(), io.StringIO()
            with patch.object(audio.sys, 'argv', ['transcribe_audio.py', '--model-dir', str(self.model)]), \
                    patch.object(audio.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(b'voice'))), \
                    patch.object(audio.sys, 'stdout', output), patch.object(audio.sys, 'stderr', errors), \
                    patch.object(audio, 'resource_limits'), patch.object(audio, 'quiet_dependencies', return_value=contextlib.nullcontext()), \
                    patch.object(audio, 'transcribe', side_effect=failure, return_value={'text': '你好', 'language': 'zh', 'duration': 1}):
                code = audio.main()
            self.assertEqual(code, 0 if expected is None else 1)
            if expected is None:
                self.assertEqual(json.loads(output.getvalue())['text'], '你好')
                self.assertEqual(errors.getvalue(), '')
            else:
                self.assertEqual(json.loads(errors.getvalue()), {'error': expected})
                self.assertEqual(output.getvalue(), '')
            self.assertNotIn('private transcript sentinel', output.getvalue() + errors.getvalue())

    def test_script_entrypoint_configures_utf8_and_rejects_empty_audio_before_model_access(self):
        class Output(io.StringIO):
            def reconfigure(stream, **options):
                self.assertEqual(options, {'encoding': 'utf-8'})
        output, errors = Output(), Output()
        with patch.object(sys, 'argv', ['transcribe_audio.py', '--model-dir', str(self.model)]), \
                patch.object(sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO())), \
                patch.object(sys, 'stdout', output), patch.object(sys, 'stderr', errors), \
                patch.object(sys, 'platform', 'win32'), patch.dict(os.environ, {}, clear=True), \
                patch.object(audio.logging, 'disable'), self.assertRaises(SystemExit) as result:
            runpy.run_path(str(ROOT / 'vm/transcribe_audio.py'), run_name='__main__')
        self.assertEqual(result.exception.code, 1)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(json.loads(errors.getvalue()), {'error': 'invalid_audio'})


if __name__ == '__main__':
    unittest.main()
