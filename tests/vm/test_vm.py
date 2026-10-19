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
import threading
import time
import unittest
from unittest.mock import patch
import zlib
import wave

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'vm'))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


image = load("patch_image", "scripts/patch-image.py")
desktop = load("desktop", "vm/desktop.py")
vm_key = load("vm_key", "scripts/vm-key.py")
voice_message = load('voice_message_test', 'vm/voice_message.py')
desktop_mcp = load('desktop_mcp_test', 'vm/desktop_mcp.py')


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
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'DANT_CONTROL_FILE': str(pathlib.Path(self.folder.name) / 'control.json')})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.folder.cleanup()

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

    def test_human_reservation_blocks_model_until_explicit_release(self):
        import control
        session = control.command({'action': 'acquire'})
        with patch.object(desktop, 'run', return_value=b''):
            with self.assertRaisesRegex(ValueError, 'human control'):
                desktop.act({'type': 'key', 'key': 'a'})
            with self.assertRaisesRegex(ValueError, 'not confirmed'):
                desktop.act({'type': 'key', 'key': 'a'}, session['sessionId'])
            control.command({'action': 'confirm', 'sessionId': session['sessionId']})
            self.assertEqual(desktop.act({'type': 'key', 'key': 'a'}, session['sessionId']), {'ok': True})
            with self.assertRaisesRegex(ValueError, 'session expired'):
                desktop.act({'type': 'key', 'key': 'a'}, 'stale-session')
            control.command({'action': 'release', 'sessionId': session['sessionId']})
            self.assertEqual(desktop.act({'type': 'key', 'key': 'a'}), {'ok': True})

    def test_expired_session_does_not_accept_input(self):
        import control
        with patch.object(control.time, 'time', return_value=1000):
            session = control.command({'action': 'acquire'})
            control.command({'action': 'confirm', 'sessionId': session['sessionId']})
        with patch.object(control.time, 'time', return_value=1121):
            with self.assertRaisesRegex(ValueError, 'expired'):
                desktop.act({'type': 'key', 'key': 'a'}, session['sessionId'])
            self.assertEqual(control.command({'action': 'status'})['status'], 'dant')

    def test_model_mcp_desktop_actions_stay_blocked_through_reservation_and_human_control(self):
        import control
        session = control.command({'action': 'acquire'})
        with patch.object(desktop_mcp, 'screenshot', return_value=b'PNG') as capture, patch.object(desktop_mcp.subprocess, 'run') as run, patch.object(desktop_mcp.subprocess, 'Popen') as launch:
            for confirmed in (False, True):
                if confirmed:
                    control.command({'action': 'confirm', 'sessionId': session['sessionId']})
                for name, arguments in [('screenshot', {}), ('key', {'key': 'a'}), ('open_url', {'url': 'https://example.invalid/login'})]:
                    with self.subTest(confirmed=confirmed, tool=name), self.assertRaisesRegex(ValueError, 'human control'):
                        desktop_mcp.invoke(name, arguments, pathlib.Path(self.folder.name))
            capture.assert_not_called()
            run.assert_not_called()
            launch.assert_not_called()
            control.command({'action': 'release', 'sessionId': session['sessionId']})
            desktop_mcp.invoke('screenshot', {}, pathlib.Path(self.folder.name))
            capture.assert_called_once()


class BrowserLaunchTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.output = pathlib.Path(self.folder.name).resolve()
        self.env = patch.dict(os.environ, {'DANT_CONTROL_FILE': str(self.output / 'control.json')})
        self.env.start()
        self.processes = []

    def tearDown(self):
        # Fixtures end themselves; never terminate a launcher or its children.
        for process in self.processes:
            process.wait(timeout=8)
        self.env.stop()
        self.folder.cleanup()

    def launcher_fixture(self, source):
        real_popen = subprocess.Popen
        def launch(arguments, **options):
            self.assertEqual(arguments, ['xdg-open', 'https://example.invalid/private-url'])
            self.assertEqual(options, {'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL,
                                       'stderr': subprocess.DEVNULL, 'close_fds': True, 'start_new_session': True})
            process = real_popen([sys.executable, '-c', source, str(self.output)], **options)
            self.processes.append(process)
            return process
        return patch.object(desktop_mcp.subprocess, 'Popen', side_effect=launch)

    def invoke(self):
        return desktop_mcp.invoke('open_url', {'url': 'https://example.invalid/private-url'}, self.output)['structuredContent']

    def wait_for_file(self, name):
        target = self.output / name
        deadline = time.monotonic() + 7
        while not target.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(target.exists(), name)

    def test_launcher_does_not_wait_for_descendant_standard_streams(self):
        child = "import pathlib,sys,time;p=pathlib.Path(sys.argv[1]);(p/'child-ready').write_text('ready');time.sleep(3);(p/'child-done').write_text('done')"
        source = f"import subprocess,sys;subprocess.Popen([sys.executable,'-c',{child!r},sys.argv[1]])"
        with self.launcher_fixture(source) as launch:
            started = time.monotonic()
            value = self.invoke()
            elapsed = time.monotonic() - started
        self.assertLess(elapsed, 1.5)
        self.assertTrue(value['launchRequested'])
        self.assertFalse(value['pageVerified'])
        self.assertNotIn('opened', value)
        launch.assert_called_once()
        self.wait_for_file('child-ready')
        self.assertFalse((self.output / 'child-done').exists())
        self.wait_for_file('child-done')

    def test_long_lived_launcher_releases_lease_before_wait_and_is_reaped_without_killing(self):
        import control
        waiting = threading.Event()
        result_values, errors = [], []
        source = "import pathlib,sys,time;p=pathlib.Path(sys.argv[1]);time.sleep(2);(p/'launcher-done').write_text('done')"
        with self.launcher_fixture(source) as launch, patch.object(desktop_mcp, 'OPEN_URL_STARTUP_SECONDS', 0.6):
            original_launch = launch.side_effect
            def instrument_launch(arguments, **options):
                process = original_launch(arguments, **options)
                original_wait = process.wait
                def wait(timeout=None):
                    if timeout is not None:
                        waiting.set()
                    return original_wait(timeout=timeout)
                process.wait = wait
                return process
            launch.side_effect = instrument_launch
            def invoke():
                try:
                    result_values.append(self.invoke())
                except Exception as error:
                    errors.append(error)
            caller = threading.Thread(target=invoke)
            caller.start()
            self.assertTrue(waiting.wait(3))
            acquired = time.monotonic()
            session = control.command({'action': 'acquire'})
            self.assertLess(time.monotonic() - acquired, 0.3)
            control.command({'action': 'release', 'sessionId': session['sessionId']})
            caller.join(3)
            self.assertFalse(caller.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(result_values, [{'launchRequested': True, 'launcherStatus': 'running', 'pageVerified': False}])
        self.assertIsNone(self.processes[0].returncode)
        self.wait_for_file('launcher-done')
        deadline = time.monotonic() + 3
        while self.processes[0].returncode is None and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.processes[0].returncode, 0)

    def test_immediate_launcher_failure_is_safe_and_not_retried(self):
        with self.launcher_fixture("import sys;sys.stderr.write('private-url private-error');sys.exit(7)") as launch, patch.object(desktop_mcp, 'OPEN_URL_STARTUP_SECONDS', 2):
            response = desktop_mcp.dispatch({'id': 87, 'method': 'tools/call', 'params': {'name': 'open_url', 'arguments': {'url': 'https://example.invalid/private-url'}}}, self.output)
        self.assertTrue(response['result']['isError'])
        message = response['result']['content'][0]['text']
        self.assertEqual(message, 'The browser launcher exited unsuccessfully; page loading was not verified. Do not retry automatically.')
        self.assertNotIn('private', message)
        launch.assert_called_once()

    def test_failed_process_start_is_safe_and_not_retried(self):
        for error in [FileNotFoundError('private executable path'), PermissionError('private-url')]:
            with self.subTest(error=type(error).__name__), patch.object(desktop_mcp.subprocess, 'Popen', side_effect=error) as launch:
                with self.assertRaisesRegex(ValueError, '^The browser launch request could not be started\\.$'):
                    self.invoke()
                launch.assert_called_once()

    def test_successful_launcher_exit_does_not_claim_page_loaded(self):
        with self.launcher_fixture('pass'), patch.object(desktop_mcp, 'OPEN_URL_STARTUP_SECONDS', 2):
            self.assertEqual(self.invoke(), {'launchRequested': True, 'launcherStatus': 'exited', 'pageVerified': False})

    def test_invalid_urls_never_start_a_launcher(self):
        with patch.object(desktop_mcp.subprocess, 'Popen') as launch:
            for url in ['javascript:alert(1)', 'file:///tmp/private', 'https://', 'https://' + 'x' * 8192, None, 42]:
                with self.subTest(url_type=type(url).__name__), self.assertRaises(ValueError):
                    desktop_mcp.invoke('open_url', {'url': url}, self.output)
            launch.assert_not_called()


class VoiceAndMCPTests(unittest.TestCase):
    @staticmethod
    def synthesize_wav(command, **options):
        with wave.open(command[-1], 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(22050)
            audio.writeframes(b'\x00\x00' * 2205)

    def test_voice_message_is_a_valid_immutable_wav_artifact(self):
        with tempfile.TemporaryDirectory() as folder:
            # Windows runner TEMP can contain an 8.3 account-name alias. The VM
            # helper intentionally rejects unresolved paths, so canonicalize the
            # test fixture rather than relaxing its Linux output-directory guard.
            output = pathlib.Path(folder).resolve()
            with patch.object(voice_message.shutil, 'which', return_value='/usr/bin/espeak-ng'), patch.object(voice_message.subprocess, 'run', side_effect=self.synthesize_wav):
                result = voice_message.create('测试语音', output)
                self.assertTrue(pathlib.Path(result['path']).is_file())
                self.assertEqual(result['type'], 'audio/wav')
                self.assertGreater(result['size'], 44)

    def test_invalid_speech_output_is_rejected_and_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            output = pathlib.Path(folder).resolve()
            def synthesize(command, **options):
                pathlib.Path(command[-1]).write_bytes(b'not a wave file')
            with patch.object(voice_message.shutil, 'which', return_value='/usr/bin/espeak-ng'), patch.object(voice_message.subprocess, 'run', side_effect=synthesize) as speech:
                with self.assertRaises(ValueError):
                    voice_message.create('test', output)
                speech.assert_called_once()
            self.assertEqual(list(output.iterdir()), [])

    @unittest.skipUnless(os.name == 'nt', 'Windows short-path aliases')
    def test_windows_short_output_path_is_canonicalized_before_synthesis(self):
        import ctypes
        with tempfile.TemporaryDirectory() as folder:
            output = pathlib.Path(folder).resolve() / 'voice output directory with spaces'
            output.mkdir()
            short_path = ctypes.windll.kernel32.GetShortPathNameW
            short_path.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
            short_path.restype = ctypes.c_uint32
            buffer = ctypes.create_unicode_buffer(32768)
            if not short_path(str(output), buffer, len(buffer)):
                self.skipTest('This filesystem does not expose Windows short paths')
            alias = pathlib.Path(buffer.value)
            self.assertEqual(alias.resolve(), output.resolve())
            if alias.absolute() != alias.resolve():
                with patch.object(voice_message.subprocess, 'run') as speech:
                    with self.assertRaisesRegex(ValueError, 'ordinary output directory'):
                        voice_message.create('unresolved alias', alias)
                    speech.assert_not_called()
            with patch.object(voice_message.shutil, 'which', return_value='/usr/bin/espeak-ng'), patch.object(voice_message.subprocess, 'run', side_effect=self.synthesize_wav):
                result = voice_message.create('alias regression', alias.resolve())
            self.assertEqual(pathlib.Path(result['path']).parent, output.resolve())

    def test_mcp_delivery_is_structured_and_does_not_send_an_http_message(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(desktop_mcp, 'credential_bridge', return_value={'quiet': False}) as bridge:
            response = desktop_mcp.dispatch({'jsonrpc': '2.0', 'id': 7, 'method': 'tools/call', 'params': {'name': 'send_chat_message', 'arguments': {'text': 'A verified link'}}}, folder)
            self.assertEqual(response['result']['structuredContent'], {'dantMessage': {'text': 'A verified link'}, 'sent': False, 'pendingPublication': True})
            self.assertFalse(response['result']['isError'])
            bridge.assert_called_once_with('chat_delivery_policy', {})
            response = desktop_mcp.dispatch({'id': 8, 'method': 'tools/call', 'params': {'name': 'open_url', 'arguments': {'url': 'javascript:alert(1)'}}}, folder)
            self.assertTrue(response['result']['isError'])

    def test_mcp_automatic_chat_receipt_is_quiet_and_policy_uncertainty_cannot_claim_send(self):
        with patch.object(desktop_mcp, 'credential_bridge', return_value={'quiet': True}) as bridge:
            response = desktop_mcp.invoke('send_chat_message', {'text': 'Routine work report'}, pathlib.Path('.'))
            self.assertEqual(response['structuredContent'], {'dantMessage': {'text': 'Routine work report'}, 'sent': False, 'pendingPublication': True, 'quiet': True, 'buffered': True})
            bridge.assert_called_once_with('chat_delivery_policy', {})
        for policy in [None, {}, {'quiet': 'true'}]:
            with patch.object(desktop_mcp, 'credential_bridge', return_value=policy):
                response = desktop_mcp.dispatch({'id': 99, 'method': 'tools/call', 'params': {'name': 'send_chat_message', 'arguments': {'text': 'Do not claim delivered'}}}, pathlib.Path('.'))
                self.assertTrue(response['result']['isError'])
                self.assertNotIn('dantMessage', response['result'].get('structuredContent', {}))
        with patch.object(desktop_mcp, 'credential_bridge', side_effect=ValueError('Unconfirmed owned scope')):
            response = desktop_mcp.dispatch({'id': 100, 'method': 'tools/call', 'params': {'name': 'send_chat_message', 'arguments': {'text': 'Do not claim delivered'}}}, pathlib.Path('.'))
            self.assertTrue(response['result']['isError'])
        self.assertNotIn('chat_delivery_policy', [tool['name'] for tool in desktop_mcp.TOOLS])

    def test_mcp_stdio_negotiation_uses_newline_json(self):
        with tempfile.TemporaryDirectory() as folder:
            messages = [{'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2024-11-05'}}, {'id': 2, 'method': 'tools/list'}]
            result = subprocess.run([sys.executable, str(ROOT / 'vm/desktop_mcp.py'), '--output-dir', folder], input=('\n'.join(map(json.dumps, messages))+'\n').encode(), capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            responses = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(responses[0]['result']['serverInfo']['name'], 'dant_desktop')
            self.assertIn('screenshot', [tool['name'] for tool in responses[1]['result']['tools']])
            self.assertIn('react_message', [tool['name'] for tool in responses[1]['result']['tools']])
            for name in ['task_list', 'task_plan', 'task_cancel', 'credential_find', 'credential_get', 'credential_request', 'credential_store', 'skill_list', 'skill_get', 'skill_save']:
                self.assertIn(name, [tool['name'] for tool in responses[1]['result']['tools']])

    def test_mcp_task_plan_waits_for_private_application_save(self):
        plan_tool = next(tool for tool in desktop_mcp.TOOLS if tool['name'] == 'task_plan')
        self.assertIn('workId', plan_tool['inputSchema']['properties'])
        self.assertNotIn('workId', plan_tool['inputSchema']['required'])
        args = {'workId': 'existing-work', 'title': 'Verify the project', 'steps': [{'step': 'Inspect', 'status': 'inProgress'}]}
        with patch.object(desktop_mcp, 'credential_bridge', return_value={'saved': True, 'workId': 'owned'}) as bridge:
            response = desktop_mcp.invoke('task_plan', args, pathlib.Path('.'))
            self.assertEqual(json.loads(response['content'][0]['text'])['taskPlanResult']['workId'], 'owned')
            bridge.assert_called_once_with('task_plan', args)
        with patch.object(desktop_mcp, 'credential_bridge', side_effect=ValueError('Not saved')):
            response = desktop_mcp.dispatch({'id': 98, 'method': 'tools/call', 'params': {'name': 'task_plan', 'arguments': args}}, pathlib.Path('.'))
            self.assertTrue(response['result']['isError'])

    def test_mcp_task_plan_preserves_a_recoverable_unsaved_binding_receipt_without_automatic_retry(self):
        bound, unrelated = 'actual-bound-work', 'unrelated-work'
        rejected = {'saved': False, 'code': 'work_conflict', 'activeWorkId': bound,
                    'guidance': 'The requested plan was not saved. Keep the exact activeWorkId and its actual task.'}
        saved = {'saved': True, 'workId': bound}
        opener = unittest.mock.Mock()
        opener.open.side_effect = [io.BytesIO(json.dumps(rejected).encode()), io.BytesIO(json.dumps(saved).encode())]
        args = {'workId': unrelated, 'title': 'Other task', 'steps': [{'step': 'Inspect', 'status': 'inProgress'}]}
        with patch.dict(os.environ, {'DANT_CREDENTIAL_BRIDGE_TOKEN': 'private-test-token'}), patch.object(desktop_mcp.urllib.request, 'build_opener', return_value=opener):
            response = desktop_mcp.dispatch({'id': 101, 'method': 'tools/call', 'params': {'name': 'task_plan', 'arguments': args}}, pathlib.Path('.'))
            self.assertFalse(response['result']['isError'])
            self.assertEqual(response['result']['structuredContent']['taskPlanResult'], rejected)
            self.assertFalse(json.loads(response['result']['content'][0]['text'])['taskPlanResult']['saved'])
            self.assertEqual(opener.open.call_count, 1)
            self.assertEqual(args['workId'], unrelated)
            corrected = {**args, 'workId': bound, 'title': 'Actual bound task'}
            result = desktop_mcp.invoke('task_plan', corrected, pathlib.Path('.'))
            self.assertEqual(result['structuredContent']['taskPlanResult'], saved)
            self.assertEqual(opener.open.call_count, 2)
        description = next(tool for tool in desktop_mcp.TOOLS if tool['name'] == 'task_plan')['description']
        self.assertIn('saved:true', description)
        self.assertIn('saved:false', description)
        self.assertIn('activeWorkId', description)

    def test_mcp_reaction_only_returns_an_application_validated_request(self):
        with tempfile.TemporaryDirectory() as folder:
            for emoji in ['👍', '❤️', None]:
                value = desktop_mcp.invoke('react_message', {'messageId': 'known-user-message', 'emoji': emoji}, folder)
                self.assertEqual(value['structuredContent'], {'dantReaction': {'messageId': 'known-user-message', 'emoji': emoji}})
                self.assertFalse(value['isError'])
                self.assertNotIn('reacted', value['structuredContent'])
            self.assertEqual(list(pathlib.Path(folder).iterdir()), [])
            for args in [{}, {'messageId': '', 'emoji': '👍'}, {'messageId': 'x' * 129, 'emoji': None},
                         {'messageId': 'user'}, {'messageId': 'user', 'emoji': 42},
                         {'messageId': 'user', 'emoji': ''}, {'messageId': 'user', 'emoji': '👍\n'}]:
                with self.assertRaises(ValueError):
                    desktop_mcp.invoke('react_message', args, folder)

    def test_mcp_task_cancellation_forwards_only_known_work_id_and_preserves_confirmation_state(self):
        spec = next(tool for tool in desktop_mcp.TOOLS if tool['name'] == 'task_cancel')['inputSchema']
        self.assertEqual(spec['required'], ['workId'])
        self.assertEqual(spec['properties'], {'workId': {'type': 'string', 'minLength': 1, 'maxLength': 128}})
        self.assertFalse(spec['additionalProperties'])
        args = {'workId': 'existing-work'}
        for actual in [{'cancelled': True, **args}, {'cancelRequested': True, **args, 'turnId': 'owned-turn'}]:
            with patch.object(desktop_mcp, 'credential_bridge', return_value=actual) as bridge:
                response = desktop_mcp.invoke('task_cancel', args, pathlib.Path('.'))
                self.assertEqual(response['structuredContent'], {'taskCancelResult': actual})
                self.assertEqual(json.loads(response['content'][0]['text']), {'taskCancelResult': actual})
                bridge.assert_called_once_with('task_cancel', args)
        for invalid in [{}, {'workId': ''}, {'workId': 'with spaces'}, {'workId': 'x' * 129}, {'workId': None},
                        {'workId': 7}, {'workId': 'x\x7f'}, {'workId': 'valid', 'turnId': 'other'},
                        {'workId': 'valid', 'callId': 'other'}, {'workId': 'valid', 'status': 'completed'}]:
            with patch.object(desktop_mcp, 'credential_bridge') as bridge:
                with self.assertRaisesRegex(ValueError, 'one existing workId'):
                    desktop_mcp.invoke('task_cancel', invalid, pathlib.Path('.'))
                bridge.assert_not_called()

    def test_mcp_task_list_is_read_only_and_accepts_no_context_selector(self):
        spec = next(tool for tool in desktop_mcp.TOOLS if tool['name'] == 'task_list')['inputSchema']
        self.assertEqual(spec, {'type': 'object', 'properties': {}, 'required': [], 'additionalProperties': False})
        actual = {'items': [{'workId': 'known-work', 'title': 'Verify changes', 'status': 'continuing', 'steps': {'completed': 1, 'total': 2}}]}
        with tempfile.TemporaryDirectory() as folder, patch.object(desktop_mcp, 'credential_bridge', return_value=actual) as bridge:
            response = desktop_mcp.invoke('task_list', {}, folder)
            self.assertEqual(response['structuredContent'], {'taskListResult': actual})
            bridge.assert_called_once_with('task_list', {})
            self.assertEqual(list(pathlib.Path(folder).iterdir()), [])
        for invalid in [{'conversationId': 'other'}, {'workId': 'known-work'}, {'status': 'running'}]:
            with patch.object(desktop_mcp, 'credential_bridge') as bridge:
                with self.assertRaisesRegex(ValueError, 'empty arguments'):
                    desktop_mcp.invoke('task_list', invalid, pathlib.Path('.'))
                bridge.assert_not_called()

    def test_task_cancellation_uses_owned_loopback_bridge_without_retry_or_secret_diagnostics(self):
        secret = 'private-plan-token-in-error'
        body = {'tool': 'task_cancel', 'arguments': {'workId': 'known-work'}}
        actual = {'cancelRequested': True, 'workId': 'known-work', 'turnId': 'owned-turn'}
        opener = unittest.mock.Mock()
        opener.open.return_value = io.BytesIO(json.dumps(actual).encode())
        with patch.dict(os.environ, {'DANT_CREDENTIAL_BRIDGE_TOKEN': 'private-test-token'}), patch.object(desktop_mcp.urllib.request, 'build_opener', return_value=opener):
            self.assertEqual(desktop_mcp.credential_bridge('task_cancel', body['arguments']), actual)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:4317/api/internal/credentials')
        self.assertEqual(request.get_header('X-dant-credential-token'), 'private-test-token')
        self.assertEqual(json.loads(request.data), body)
        self.assertEqual(opener.open.call_count, 1)

        for status in [400, 403, 409, 500]:
            opener = unittest.mock.Mock()
            opener.open.side_effect = desktop_mcp.urllib.error.HTTPError(request.full_url, status, secret, {}, io.BytesIO(json.dumps({'error': secret}).encode()))
            with patch.dict(os.environ, {'DANT_CREDENTIAL_BRIDGE_TOKEN': 'private-test-token'}), patch.object(desktop_mcp.urllib.request, 'build_opener', return_value=opener):
                with self.assertRaises(ValueError) as raised:
                    desktop_mcp.credential_bridge('task_cancel', body['arguments'])
            self.assertEqual(str(raised.exception), f'Task cancellation request was rejected (HTTP {status})')
            self.assertEqual(opener.open.call_count, 1)
        opener = unittest.mock.Mock()
        opener.open.side_effect = OSError(secret)
        with patch.dict(os.environ, {'DANT_CREDENTIAL_BRIDGE_TOKEN': 'private-test-token'}), patch.object(desktop_mcp.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaises(ValueError) as raised:
                desktop_mcp.credential_bridge('task_cancel', body['arguments'])
        self.assertEqual(str(raised.exception), 'The task cancellation result is unconfirmed. Check Work progress; do not retry cancellation automatically.')
        self.assertEqual(opener.open.call_count, 1)

    def test_task_list_bridge_failures_do_not_expose_private_errors(self):
        for transport_error, expected in [
                (desktop_mcp.urllib.error.HTTPError('http://127.0.0.1:4317/api/internal/credentials', 409, 'private-token-in-error', {}, io.BytesIO(b'private-body')),
                 'Task list request was rejected (HTTP 409)'),
                (OSError('private-token-in-error'), 'The task list result is unconfirmed. Check Work progress for saved tasks.')]:
            opener = unittest.mock.Mock()
            opener.open.side_effect = transport_error
            with patch.dict(os.environ, {'DANT_CREDENTIAL_BRIDGE_TOKEN': 'private-test-token'}), patch.object(desktop_mcp.urllib.request, 'build_opener', return_value=opener):
                with self.assertRaises(ValueError) as raised:
                    desktop_mcp.credential_bridge('task_list', {})
            self.assertEqual(str(raised.exception), expected)
            self.assertEqual(opener.open.call_count, 1)

    def test_private_credential_bridge_uses_fixed_loopback_token_header_and_bounded_result(self):
        class Response(io.BytesIO):
            pass
        class Opener:
            def __init__(self, response):
                self.response = response
                self.requests = []
            def open(self, request, timeout):
                self.requests.append((request, timeout))
                return self.response
        opener = Opener(Response(json.dumps({'id': 'id', 'secret': 'test-secret'}).encode()))
        with patch.dict(os.environ, {'DANT_CREDENTIAL_BRIDGE_TOKEN': 'ephemeral-test-token'}), patch.object(desktop_mcp.urllib.request, 'build_opener', return_value=opener) as build:
            value = desktop_mcp.invoke('credential_get', {'id': 'id'}, pathlib.Path('.'))
        self.assertEqual(value['structuredContent']['credentialResult']['secret'], 'test-secret')
        request, timeout = opener.requests[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:4317/api/internal/credentials')
        self.assertEqual(request.method, 'POST')
        self.assertEqual(timeout, 600)
        self.assertEqual(request.get_header('X-dant-credential-token'), 'ephemeral-test-token')
        self.assertEqual(json.loads(request.data), {'tool': 'credential_get', 'arguments': {'id': 'id'}})
        self.assertIsInstance(build.call_args.args[0], desktop_mcp.urllib.request.ProxyHandler)
        self.assertEqual(build.call_args.args[0].proxies, {})
        self.assertIsInstance(build.call_args.args[1], desktop_mcp.NoCredentialRedirect)
        self.assertIsNone(build.call_args.args[1].redirect_request(None, None, 302, '', {}, 'http://evil.test'))
        with patch.dict(os.environ, {'DANT_CREDENTIAL_BRIDGE_TOKEN': ''}), patch.object(desktop_mcp.urllib.request, 'build_opener') as build:
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                desktop_mcp.invoke('credential_find', {'query': ''}, pathlib.Path('.'))
            build.assert_not_called()

    def test_private_credential_bridge_errors_never_expose_response_or_input_secrets(self):
        class Opener:
            def open(self, request, timeout):
                raise OSError('private-token or private-secret in unsafe diagnostic')
        with patch.dict(os.environ, {'DANT_CREDENTIAL_BRIDGE_TOKEN': 'test-token'}), patch.object(desktop_mcp.urllib.request, 'build_opener', return_value=Opener()):
            response = desktop_mcp.dispatch({'id': 99, 'method': 'tools/call', 'params': {'name': 'credential_store', 'arguments': {'secret': 'private-secret'}}}, pathlib.Path('.'))
        self.assertTrue(response['result']['isError'])
        text = json.dumps(response)
        self.assertNotIn('private-secret', text)
        self.assertNotIn('private-token', text)
        self.assertIn('not retry', text)

    def test_task_progress_http_rejections_use_only_fixed_codes_and_never_retry_or_echo_bodies(self):
        messages = {
            'work_not_found': 'specified work ID was not found',
            'work_conflict': 'already bound to a different current task',
            'work_not_continuable': 'completed, active, failed, pausing, or unconfirmed',
            'work_stale_turn': 'historical or inactive turn cannot replace the current task owner',
        }
        secret = 'private-token-and-plan-content'

        class Body(io.BytesIO):
            def __init__(self, data):
                super().__init__(data)
                self.read_sizes = []
            def read(self, count=-1):
                self.read_sizes.append(count)
                return super().read(count)

        class Opener:
            def __init__(self, body, status=400):
                self.body, self.status, self.calls = body, status, 0
            def open(self, request, timeout):
                self.calls += 1
                raise desktop_mcp.urllib.error.HTTPError(request.full_url, self.status, secret, {}, self.body)

        class BrokenBody(Body):
            def read(self, count=-1):
                self.read_sizes.append(count)
                raise RuntimeError(secret)

        for code, expected in messages.items():
            with self.subTest(code=code):
                body = Body(json.dumps({'code': code, 'error': secret, 'arguments': secret}).encode())
                opener = Opener(body)
                with patch.dict(os.environ, {'DANT_CREDENTIAL_BRIDGE_TOKEN': 'private-test-token'}), patch.object(desktop_mcp.urllib.request, 'build_opener', return_value=opener):
                    response = desktop_mcp.dispatch({'id': 99, 'method': 'tools/call', 'params': {'name': 'task_plan', 'arguments': {'title': secret}}}, pathlib.Path('.'))
                self.assertTrue(response['result']['isError'])
                text = response['result']['content'][0]['text']
                self.assertIn('Task progress request rejected:', text)
                self.assertIn(expected, text)
                self.assertNotIn(secret, text)
                self.assertEqual(body.read_sizes, [4097])
                self.assertEqual(opener.calls, 1)

        malformed = [b'not json ' + secret.encode(), b'\xff', b'[' * 4000,
                     json.dumps({'code': [secret], 'error': secret}).encode(),
                     json.dumps({'code': secret}).encode(),
                     json.dumps({'code': 'work_not_found', 'padding': secret * 200}).encode()]
        for data in malformed:
            with self.subTest(body_size=len(data)):
                body, opener = Body(data), None
                opener = Opener(body)
                with patch.dict(os.environ, {'DANT_CREDENTIAL_BRIDGE_TOKEN': 'private-test-token'}), patch.object(desktop_mcp.urllib.request, 'build_opener', return_value=opener):
                    with self.assertRaisesRegex(ValueError, '^Task progress request was rejected \\(HTTP 400\\)$'):
                        desktop_mcp.credential_bridge('task_plan', {'title': secret})
                self.assertEqual(body.read_sizes, [4097])
                self.assertEqual(opener.calls, 1)

        body = BrokenBody(b'')
        opener = Opener(body)
        with patch.dict(os.environ, {'DANT_CREDENTIAL_BRIDGE_TOKEN': 'private-test-token'}), patch.object(desktop_mcp.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(ValueError, '^Task progress request was rejected \\(HTTP 400\\)$'):
                desktop_mcp.credential_bridge('task_plan', {'title': secret})
        self.assertEqual(body.read_sizes, [4097])
        self.assertEqual(opener.calls, 1)

        for name, status, expected in [('task_plan', 409, 'Task progress request was rejected (HTTP 409)'),
                                       ('credential_get', 400, 'The credential request was rejected (HTTP 400)')]:
            body = Body(json.dumps({'code': 'work_not_found', 'error': secret}).encode())
            opener = Opener(body, status)
            with patch.dict(os.environ, {'DANT_CREDENTIAL_BRIDGE_TOKEN': 'private-test-token'}), patch.object(desktop_mcp.urllib.request, 'build_opener', return_value=opener):
                with self.assertRaises(ValueError) as raised:
                    desktop_mcp.credential_bridge(name, {'id': secret})
            self.assertEqual(str(raised.exception), expected)
            self.assertEqual(body.read_sizes, [])
            self.assertEqual(opener.calls, 1)

    def test_task_progress_lost_response_remains_unconfirmed_without_retry_or_diagnostic_echo(self):
        opener = unittest.mock.Mock()
        opener.open.side_effect = OSError('private-plan-and-token-in-transport-error')
        with patch.dict(os.environ, {'DANT_CREDENTIAL_BRIDGE_TOKEN': 'private-test-token'}), patch.object(desktop_mcp.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaises(ValueError) as raised:
                desktop_mcp.credential_bridge('task_plan', {'title': 'private-plan'})
        self.assertEqual(str(raised.exception), 'The task progress result is unconfirmed. Do not retry a task progress write automatically.')
        self.assertEqual(opener.open.call_count, 1)

    def test_mcp_skill_tools_use_the_same_private_owned_bridge_without_reading_or_writing_files(self):
        save_tool = next(tool for tool in desktop_mcp.TOOLS if tool['name'] == 'skill_save')
        self.assertEqual(save_tool['inputSchema']['properties']['files']['maxProperties'], 128)
        with tempfile.TemporaryDirectory() as folder, patch.object(desktop_mcp, 'credential_bridge', return_value={'saved': True}) as bridge:
            for name, args in [('skill_list', {}), ('skill_get', {'name': 'known'}), ('skill_save', {'name': 'known', 'description': 'Reusable', 'instructions': 'Check first'})]:
                response = desktop_mcp.invoke(name, args, folder)
                self.assertEqual(response['structuredContent'], {'skillResult': {'saved': True}})
                bridge.assert_called_with(name, args)
            files = {f'scripts/helper-{index}.py': f'print({index})\n' for index in range(30)}
            args = {'name': 'complete-skill', 'description': 'All helpers', 'instructions': 'Use the packaged helpers.', 'files': files}
            response = desktop_mcp.invoke('skill_save', args, folder)
            bridge.assert_called_with('skill_save', args)
            self.assertEqual(response['structuredContent'], {'skillResult': {'saved': True}})
            self.assertEqual(list(pathlib.Path(folder).iterdir()), [])

    def test_mcp_schedule_tools_share_the_private_owned_service_without_executing_or_writing_jobs_locally(self):
        names = {tool['name']: tool for tool in desktop_mcp.TOOLS}
        self.assertEqual(names['schedule_save']['inputSchema']['properties']['at']['type'], 'string')
        self.assertIn('timeZone', names['schedule_save']['inputSchema']['properties'])
        self.assertEqual(names['schedule_save']['inputSchema']['properties']['cron']['type'], ['string', 'null'])
        self.assertEqual(names['schedule_save']['inputSchema']['properties']['priority']['enum'], ['high', 'normal', 'low'])
        with tempfile.TemporaryDirectory() as folder, patch.object(desktop_mcp, 'credential_bridge', return_value={'saved': True}) as bridge:
            for name, args in [('schedule_list', {}), ('schedule_save', {'text': 'A requested future check', 'at': '2026-10-18T09:00:00+08:00', 'timeZone': 'Asia/Kuala_Lumpur'}), ('schedule_save', {'text': 'A requested daily check', 'cron': '0 9 * * *', 'priority': 'high', 'timeZone': 'Asia/Kuala_Lumpur'}), ('schedule_delete', {'id': 'saved-job'})]:
                response = desktop_mcp.invoke(name, args, folder)
                self.assertEqual(response['structuredContent'], {'scheduleResult': {'saved': True}})
                bridge.assert_called_with(name, args)
            self.assertEqual(list(pathlib.Path(folder).iterdir()), [])
        with patch.object(desktop_mcp, 'credential_bridge', side_effect=ValueError('The current owner changed')):
            response = desktop_mcp.dispatch({'id': 99, 'method': 'tools/call', 'params': {'name': 'schedule_save', 'arguments': {'text': 'Never claim this was saved'}}}, pathlib.Path('.'))
            self.assertTrue(response['result']['isError'])


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
            summary = json.loads((cache / 'seed-summary.json').read_text())
            self.assertEqual(summary['provider'], 'hyperv')
            self.assertIn('Azure VHD', summary['image'])
            vmware_result = subprocess.run(command + ['--provider', 'vmware'], env=env, capture_output=True)
            self.assertEqual(vmware_result.returncode, 0, vmware_result.stderr.decode())
            summary = json.loads((cache / 'seed-summary.json').read_text())
            self.assertEqual(summary['provider'], 'vmware')
            self.assertIn('VMware VMDK', summary['image'])
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
