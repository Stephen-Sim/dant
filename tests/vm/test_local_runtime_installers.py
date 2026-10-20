"""Pinned speech and ASR installers with local bytes and fake package/process boundaries."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


speech = module('speech_installer', 'vm/install-speech.py')
with patch.dict(sys.modules, {'fcntl': types.SimpleNamespace(LOCK_EX=2, flock=lambda *_: None)}):
    transcription = module('transcription_installer', 'vm/install-transcription.py')


class LocalRuntimeInstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = pathlib.Path(temporary.name).resolve()

    def run_speech(self, failure=None, cli=False):
        root = self.home / 'speech'
        root.mkdir(exist_ok=True)
        data = b'Synthetic signed archive fixture'
        digest = hashlib.sha256(data).hexdigest()
        calls = []

        def run(args, **options):
            calls.append(args)
            if args[:2] == ['apt-get', '--print-uris']:
                output = f"'https://archive.ubuntu.com/pool/fixture.deb' fixture.deb {len(data)} SHA256:unused\n"
                if failure == 'origin':
                    output = output.replace('archive.ubuntu.com', 'untrusted.invalid')
                elif failure == 'filename':
                    output = output.replace(" fixture.deb ", " ../fixture.deb ")
                elif failure == 'resolution':
                    output = ''
                elif failure == 'size':
                    output = output.replace(f' {len(data)} ', ' 999 ')
                return types.SimpleNamespace(stdout=output)
            if args[:2] == ['apt-cache', 'show']:
                output = 'SHA256: ' + ('x' * 64 if failure == 'metadata' else digest) + '\n'
                if failure == 'ambiguous':
                    output += 'SHA256: ' + 'b' * 64 + '\n'
                return types.SimpleNamespace(stdout=output)
            if args[:2] == ['apt-get', 'download']:
                if failure == 'download':
                    raise subprocess.CalledProcessError(1, args)
                (pathlib.Path(options['cwd']) / 'fixture.deb').write_bytes(b'wrong' if failure == 'checksum' else data)
            elif args[:2] == ['dpkg-deb', '-x']:
                self.assertEqual(pathlib.Path(args[3]), root)
            else:
                self.fail('No unplanned process may run.')
            return types.SimpleNamespace(returncode=0)

        with patch.object(speech.subprocess, 'run', side_effect=run):
            if cli:
                with patch.object(sys, 'argv', ['install-speech.py', str(root)]):
                    runpy.run_path(str(ROOT / 'vm/install-speech.py'), run_name='__main__')
            else:
                speech.install(root)
        return root, calls

    def test_speech_manifest_commits_only_after_all_five_authenticated_archives(self):
        root, calls = self.run_speech(cli=True)
        result = json.loads((root / 'deployment.json').read_text())
        self.assertEqual(len(result['packages']), 5)
        self.assertEqual(len([call for call in calls if call[:2] == ['dpkg-deb', '-x']]), 5)
        self.assertTrue(all(item['sha256'] == hashlib.sha256(b'Synthetic signed archive fixture').hexdigest() for item in result['packages']))

    def test_speech_invalid_origin_name_size_metadata_and_payload_never_publish(self):
        for failure in ('origin', 'filename', 'resolution', 'size', 'metadata', 'ambiguous', 'checksum', 'download'):
            with self.subTest(failure=failure):
                with self.assertRaises((AssertionError, subprocess.CalledProcessError)):
                    self.run_speech(failure)
                self.assertFalse((self.home / 'speech/deployment.json').exists())

    def transcription_fixture(self, failure=None):
        parent = self.home / 'dant/runtime'
        parent.mkdir(parents=True, exist_ok=True)
        root = parent / 'transcription'
        requirements = self.home / 'requirements.lock'
        requirements.write_bytes(b'isolated pinned wheel lock\n')
        payload = b'synthetic local model bytes'
        calls = []
        files = {'model.bin': (len(payload), hashlib.sha256(payload).hexdigest())}
        original_replace = os.replace

        class Environment:
            def __init__(self, with_pip):
                self.with_pip = with_pip

            def create(self, path):
                if failure == 'environment':
                    raise OSError('synthetic environment error')
                (path / 'bin').mkdir(parents=True)
                (path / 'bin/python').write_bytes(b'isolated executable marker')

        def run(args, **options):
            calls.append(args)
            if '-m' in args:
                self.assertIn('--require-hashes', args)
                self.assertIn('--only-binary=:all:', args)
                return types.SimpleNamespace(returncode=1 if failure == 'pip' else 0)
            self.assertEqual(args[-1], 'import av,ctranslate2,faster_whisper,numpy')
            self.assertEqual(options['env']['HF_HUB_OFFLINE'], '1')
            if failure == 'imports-error':
                raise subprocess.TimeoutExpired(args, 45)
            return types.SimpleNamespace(returncode=1 if failure == 'imports' else 0)

        def download(url, timeout):
            self.assertTrue(url.startswith('https://huggingface.co/Systran/faster-whisper-small/resolve/'))
            self.assertEqual(timeout, 60)
            if failure == 'network':
                raise OSError('PRIVATE DOWNLOAD RESPONSE')
            value = b'excess bytes' * 10 if failure == 'large' else b'wrong' if failure == 'checksum' else payload
            return io.BytesIO(value)

        def replace(source, target):
            if failure == 'commit' and pathlib.Path(source).name.startswith('.transcription-stage-') and target == root:
                raise OSError('synthetic atomic rename failure')
            return original_replace(source, target)

        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(pathlib.Path, 'home', return_value=self.home))
        stack.enter_context(patch.object(os, 'geteuid', return_value=1000, create=True))
        stack.enter_context(patch.object(os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True))
        stack.enter_context(patch.object(transcription.platform, 'machine', return_value='x86_64'))
        stack.enter_context(patch.object(sys, 'argv', ['install-transcription.py', str(requirements)]))
        stack.enter_context(patch.object(transcription, 'FILES', files))
        stack.enter_context(patch.object(transcription.venv, 'EnvBuilder', Environment))
        stack.enter_context(patch.object(transcription.subprocess, 'run', side_effect=run))
        stack.enter_context(patch.object(transcription.urllib.request, 'urlopen', side_effect=download))
        stack.enter_context(patch.object(transcription.os, 'replace', side_effect=replace))
        return stack, root, parent, calls

    def test_transcription_install_verifies_before_commit_and_second_install_is_read_only(self):
        stack, root, parent, calls = self.transcription_fixture()
        with stack, contextlib.redirect_stdout(io.StringIO()):
            transcription.install()
            marker = (root / 'deployment.json').read_bytes()
            self.assertEqual((root / 'model/model.bin').read_bytes(), b'synthetic local model bytes')
            self.assertEqual(len(list(parent.glob('.transcription-stage-*'))), 0)
            first = len(calls)
            transcription.install()
            self.assertEqual((root / 'deployment.json').read_bytes(), marker)
            self.assertEqual(len(calls) - first, 1)
            self.assertNotIn('-m', calls[-1])

    def test_transcription_failures_preserve_old_runtime_and_clean_only_owned_staging(self):
        for failure in ('environment', 'pip', 'network', 'large', 'checksum', 'imports', 'commit'):
            with self.subTest(failure=failure):
                stack, root, parent, _ = self.transcription_fixture(failure)
                root.mkdir(exist_ok=True)
                (root / 'previous').write_bytes(b'preserve this runtime')
                with stack, self.assertRaises((OSError, transcription.SetupError)):
                    transcription.install()
                self.assertEqual((root / 'previous').read_bytes(), b'preserve this runtime')
                self.assertEqual(list(parent.glob('.transcription-stage-*')), [])
                self.assertEqual(list(parent.glob('.transcription-old-*')), [])

    def test_transcription_rejects_unsafe_paths_invalid_models_and_unsupported_hosts(self):
        with self.assertRaisesRegex(transcription.SetupError, 'unsafe_path'):
            transcription.safe_directory(self.home.parent, self.home)
        with self.assertRaisesRegex(transcription.SetupError, 'unsafe_path'):
            transcription.safe_directory(self.home / 'missing', self.home)
        file = self.home / 'ordinary'
        file.write_bytes(b'file')
        with self.assertRaisesRegex(transcription.SetupError, 'unsafe_path'):
            transcription.safe_directory(file, self.home)
        with self.assertRaisesRegex(transcription.SetupError, 'unsafe_path'):
            transcription.remove_staging(self.home / 'foreign', self.home)
        self.assertFalse(transcription.model_valid(self.home / 'missing'))
        model = self.home / 'model'
        model.mkdir()
        self.assertFalse(transcription.model_valid(model))
        with patch.object(os, 'geteuid', return_value=0, create=True), self.assertRaisesRegex(transcription.SetupError, 'unsupported_platform'):
            transcription.install()
        with patch.object(transcription, 'install', side_effect=OSError('PRIVATE FAILURE')), contextlib.redirect_stderr(io.StringIO()) as stderr:
            with self.assertRaises(SystemExit) as error:
                transcription.main()
        self.assertEqual(error.exception.code, 1)
        self.assertIn('setup_failed', stderr.getvalue())
        self.assertNotIn('PRIVATE', stderr.getvalue())

    def test_transcription_path_model_and_lock_failures_do_not_install_dependencies(self):
        directory = self.home / 'new/tree'
        transcription.safe_directory(directory, self.home, create=True)
        self.assertTrue(directory.is_dir())
        transcription.remove_staging(self.home / '.transcription-stage-absent', self.home)
        with patch.object(pathlib.Path, 'is_symlink', return_value=True), self.assertRaisesRegex(transcription.SetupError, 'unsafe_path'):
            transcription.safe_directory(self.home, self.home)
        model = self.home / 'wrong-model'
        model.mkdir()
        (model / 'model.bin').write_bytes(b'xxxx')
        with patch.object(transcription, 'FILES', {'model.bin': (4, hashlib.sha256(b'abcd').hexdigest())}):
            self.assertFalse(transcription.model_valid(model))
            with patch.object(pathlib.Path, 'open', side_effect=OSError('synthetic read error')):
                self.assertFalse(transcription.model_valid(model))
        stack, _, _, calls = self.transcription_fixture()
        with stack:
            (self.home / 'requirements.lock').unlink()
            with self.assertRaisesRegex(transcription.SetupError, 'invalid_lock'):
                transcription.install()
        self.assertEqual(calls, [])
        stack, _, _, calls = self.transcription_fixture()
        metadata = os.stat(self.home)
        with stack, patch.object(os, 'fstat', return_value=types.SimpleNamespace(st_mode=metadata.st_mode, st_nlink=2)):
            with self.assertRaisesRegex(transcription.SetupError, 'unsafe_path'):
                transcription.install()
        self.assertEqual(calls, [])

    def test_invalid_prior_marker_is_replaced_only_after_success_and_cli_masks_platform_errors(self):
        stack, root, parent, _ = self.transcription_fixture()
        root.mkdir()
        (root / 'deployment.json').write_text('not JSON')
        with stack, contextlib.redirect_stdout(io.StringIO()):
            transcription.install()
        self.assertEqual(list(parent.glob('.transcription-old-*')), [])
        self.assertTrue(json.loads((root / 'deployment.json').read_text())['fingerprint'])
        with patch.dict(sys.modules, {'fcntl': types.SimpleNamespace(LOCK_EX=2, flock=lambda *_: None)}), \
                patch.object(os, 'geteuid', return_value=0, create=True), \
                contextlib.redirect_stderr(io.StringIO()) as stderr, self.assertRaises(SystemExit) as error:
            runpy.run_path(str(ROOT / 'vm/install-transcription.py'), run_name='__main__')
        self.assertEqual(error.exception.code, 1)
        self.assertIn('unsupported_platform', stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
