"""Real WAV serialization with injected speech process, no installed voice engine."""
import contextlib
import importlib.util
import io
import json
import pathlib
import runpy
import sys
import tempfile
import types
import unittest
import wave
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('voice_cli_test', ROOT / 'vm/voice_message.py')
voice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice)


class VoiceMessageCLITests(unittest.TestCase):
    def test_invalid_text_language_and_missing_engine_never_synthesize(self):
        with tempfile.TemporaryDirectory() as folder:
            for text, language in (('', None), (None, None), ('x' * 2501, None), ('hello', 'foreign')):
                with self.subTest(language=language), patch.object(voice.subprocess, 'run') as process, self.assertRaises(ValueError):
                    voice.create(text, folder, language)
                process.assert_not_called()
            with patch.object(voice.shutil, 'which', return_value=None), patch.object(voice.subprocess, 'run') as process, self.assertRaises(RuntimeError):
                voice.create('hello', folder)
            process.assert_not_called()

    def test_cli_creates_valid_wav_and_oversized_or_malformed_input_has_no_speech_effect(self):
        with tempfile.TemporaryDirectory() as folder:
            for body, success in ((json.dumps({'text': 'hello', 'language': 'en'}).encode(), True),
                    (b'x' * 20001, False), (b'invalid json', False)):
                output, errors = io.StringIO(), io.StringIO()
                def synthesize(arguments, **options):
                    self.assertEqual(arguments[:4], ['/synthetic/espeak', '--stdin', '-v', 'en'])
                    self.assertEqual(options['input'], b'hello')
                    self.assertEqual(options['timeout'], 45)
                    with wave.open(arguments[-1], 'wb') as writer:
                        writer.setnchannels(1)
                        writer.setsampwidth(2)
                        writer.setframerate(16000)
                        writer.writeframes(b'\x01\x00' * 100)
                    return types.SimpleNamespace(returncode=0)
                with patch('shutil.which', return_value='/synthetic/espeak'), patch('subprocess.run', side_effect=synthesize) as process, \
                        patch.object(sys, 'argv', ['voice_message.py', '--output-dir', folder]), \
                        patch.object(sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(body))), \
                        contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    if success:
                        runpy.run_path(str(ROOT / 'vm/voice_message.py'), run_name='__main__')
                    else:
                        with self.assertRaises(SystemExit) as failure:
                            runpy.run_path(str(ROOT / 'vm/voice_message.py'), run_name='__main__')
                        self.assertEqual(failure.exception.code, 1)
                if success:
                    result = json.loads(output.getvalue())
                    self.assertEqual(result['type'], 'audio/wav')
                    self.assertEqual(pathlib.Path(result['path']).stat().st_size, result['size'])
                    self.assertEqual(process.call_count, 1)
                    self.assertEqual(errors.getvalue(), '')
                else:
                    process.assert_not_called()
                    self.assertEqual(output.getvalue(), '')
                    self.assertEqual(set(json.loads(errors.getvalue())), {'error'})


if __name__ == '__main__':
    unittest.main()
