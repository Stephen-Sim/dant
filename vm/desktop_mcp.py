#!/usr/bin/env python3
"""Minimal MCP stdio server for the dedicated dant VM desktop."""
import argparse
import base64
import json
import os
import pathlib
import subprocess
import sys
from urllib.parse import urlparse
import urllib.error
import urllib.request
from desktop import act, screenshot
from control import desktop_access
from voice_message import create as create_voice

def tool(name, description, properties, required=()):
    return {'name': name, 'description': description, 'inputSchema': {'type': 'object', 'properties': properties, 'required': list(required), 'additionalProperties': False}}

NUMBER = {'type': 'integer', 'minimum': 0, 'maximum': 4096}
TEXT = {'type': 'string'}
TOOLS = [
    tool('task_plan', 'Register entrusted work before execution and wait for its saved acknowledgement. Reuse the returned workId for related follow-ups across turns, updating the actual title and steps. Decide whether a request belongs to that task; ordinary conversation creates no task. A reply does not finish unfinished work. This never starts execution, grants permission, or completes it.', {'workId': {'type': 'string', 'minLength': 1, 'maxLength': 128}, 'title': {'type': 'string', 'minLength': 1, 'maxLength': 240}, 'steps': {'type': 'array', 'minItems': 1, 'maxItems': 128, 'items': {'type': 'object', 'properties': {'step': {'type': 'string', 'minLength': 1, 'maxLength': 5000}, 'status': {'type': 'string', 'enum': ['pending', 'inProgress', 'completed']}}, 'required': ['step', 'status'], 'additionalProperties': False}}}, ['title', 'steps']),
    tool('screenshot', 'Observe the current VM desktop.', {}),
    tool('click', 'Click the VM desktop at screenshot coordinates.', {'x': NUMBER, 'y': NUMBER, 'button': {'type': 'integer', 'enum': [0, 1, 2]}}, ['x', 'y']),
    tool('drag', 'Drag on the VM desktop.', {'startX': NUMBER, 'startY': NUMBER, 'endX': NUMBER, 'endY': NUMBER, 'button': {'type': 'integer', 'enum': [0, 1, 2]}}, ['startX', 'startY', 'endX', 'endY']),
    tool('key', 'Press a key chord such as ctrl+l or Return.', {'key': TEXT}, ['key']),
    tool('type_text', 'Paste Unicode text into the active VM application.', {'text': TEXT}, ['text']),
    tool('scroll', 'Scroll the active VM application; negative is up.', {'delta': {'type': 'integer', 'minimum': -12, 'maximum': 12}}, ['delta']),
    tool('open_url', 'Open an HTTP or HTTPS page in the VM browser.', {'url': TEXT}, ['url']),
    tool('send_chat_message', 'Explicitly deliver text or links to the current chat. The application validates and publishes this result.', {'text': TEXT}, ['text']),
    tool('react_message', 'Optionally request dant\'s own one-emoji reaction on a real user message ID from chat references. Use sparingly; null removes it. The application validates and applies this result independently of user reactions.', {'messageId': {'type': 'string', 'minLength': 1, 'maxLength': 128}, 'emoji': {'type': ['string', 'null'], 'maxLength': 64}}, ['messageId', 'emoji']),
    tool('credential_find', 'Find saved credential metadata in the encrypted VM vault before asking the user. No secret values are returned.', {'query': {'type': 'string', 'maxLength': 300}}, ['query']),
    tool('credential_get', 'Read a credential secret for the current authorized work only. Never echo or log it, put it in chat/memory, or write an ordinary file.', {'id': {'type': 'string', 'maxLength': 128}}, ['id']),
    tool('credential_request', 'Request a missing credential through the separate secure form. Never ask for passwords or API keys in chat. Waits for the user and returns metadata only.', {'name': {'type': 'string', 'maxLength': 100}, 'service': {'type': 'string', 'maxLength': 200}, 'reason': {'type': 'string', 'maxLength': 500}}, ['name', 'service', 'reason']),
    tool('credential_store', 'Store or update a credential in the encrypted VM vault. Do not copy its value to chat, memory, or ordinary files.', {'id': {'type': 'string', 'maxLength': 128}, 'name': {'type': 'string', 'maxLength': 100}, 'service': {'type': 'string', 'maxLength': 200}, 'username': {'type': 'string', 'maxLength': 300}, 'secret': {'type': 'string', 'maxLength': 16384}}, ['name', 'service', 'username', 'secret']),
    tool('skill_list', 'List real reusable dant-managed skills for this workspace.', {}),
    tool('schedule_list', 'List saved one-time tasks, their ids, execution times, timezones and states. Listing never executes a task.', {}),
    tool('schedule_save', 'Create or update a one-time scheduled task only when requested. New tasks require text, an ISO time with explicit UTC offset and IANA timeZone. Reuse id for changes, enabled false pauses. Saving does not execute work now or create recurrence.', {'id': {'type': 'string', 'minLength': 1, 'maxLength': 128}, 'text': {'type': 'string', 'minLength': 1}, 'at': {'type': 'string', 'minLength': 1, 'maxLength': 40}, 'timeZone': {'type': 'string', 'minLength': 1, 'maxLength': 100}, 'enabled': {'type': 'boolean'}}, []),
    tool('schedule_delete', 'Remove a requested scheduled task by id. This does not stop work already dispatched.', {'id': {'type': 'string', 'minLength': 1, 'maxLength': 128}}, ['id']),
    tool('skill_get', 'Read a managed skill and supporting text files before applying or improving it.', {'name': {'type': 'string', 'maxLength': 64}}, ['name']),
    tool('skill_save', 'Create or improve a self-contained skill with actual SKILL.md and helper source, tests, licenses, package manifests and lockfiles under scripts/references/assets. Use relative paths inside the skill; never depend on external workspace helpers. Omit files to preserve existing supporting files; supplying files replaces the entire supporting file map. Keep secrets in the credential vault; test helper scripts before claiming readiness.', {'name': {'type': 'string', 'maxLength': 64}, 'description': {'type': 'string', 'maxLength': 1000}, 'instructions': {'type': 'string', 'maxLength': 49152}, 'files': {'type': 'object', 'additionalProperties': {'type': 'string', 'maxLength': 65536}, 'maxProperties': 128}, 'enabled': {'type': 'boolean'}}, ['name', 'description', 'instructions']),
    tool('create_voice_message', 'Create a real local WAV file for attachment delivery.', {'text': TEXT, 'language': {'type': 'string', 'enum': ['zh', 'en']}}, ['text']),
]

def result(value):
    return {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}], 'structuredContent': value, 'isError': False}


class NoCredentialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def credential_bridge(name, args):
    token = os.environ.get('DANT_CREDENTIAL_BRIDGE_TOKEN', '')
    if not token or len(token) > 256 or any(ord(char) < 33 or ord(char) > 126 for char in token):
        raise ValueError('The private credential bridge is unavailable')
    payload = json.dumps({'tool': name, 'arguments': args}, ensure_ascii=False).encode('utf-8')
    if len(payload) > 512 * 1024:
        raise ValueError('Private tool input exceeds its size limit')
    request = urllib.request.Request('http://127.0.0.1:4317/api/internal/credentials', data=payload,
                                     headers={'Content-Type': 'application/json', 'X-Dant-Credential-Token': token}, method='POST')
    # Ignore host proxies and refuse redirects: secrets never leave this fixed
    # loopback route. The HTTP endpoint authenticates a separate ephemeral token
    # and checks the current task/call owner before accessing the VM vault.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoCredentialRedirect())
    try:
        with opener.open(request, timeout=600) as response:
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError('Credential result exceeds its size limit')
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        raise ValueError(f'The credential request was rejected (HTTP {error.code})') from None
    except (OSError, ValueError):
        # Do not include request bodies, response bodies, tokens, or credentials
        # in diagnostics. Writes with a lost response must not be blindly retried.
        raise ValueError('The private credential result is unconfirmed. Do not retry a credential write automatically.') from None

def invoke(name, args, output_dir):
    if not isinstance(args, dict):
        raise ValueError('Tool arguments must be an object')
    if name == 'task_plan':
        return result({'taskPlanResult': credential_bridge(name, args)})
    if name in ('credential_find', 'credential_get', 'credential_request', 'credential_store'):
        return result({'credentialResult': credential_bridge(name, args)})
    if name in ('skill_list', 'skill_get', 'skill_save'):
        return result({'skillResult': credential_bridge(name, args)})
    if name in ('schedule_list', 'schedule_save', 'schedule_delete'):
        return result({'scheduleResult': credential_bridge(name, args)})
    if name == 'screenshot':
        with desktop_access():
            data = screenshot()
        if len(data) > 10 * 1024 * 1024:
            raise ValueError('Screenshot exceeds 10 MiB')
        return {'content': [{'type': 'image', 'mimeType': 'image/png', 'data': base64.b64encode(data).decode()}]}
    if name in ('click', 'drag', 'key', 'scroll', 'type_text'):
        return result(act({**args, 'type': 'text' if name == 'type_text' else name}))
    if name == 'open_url':
        url = args.get('url', '')
        if not isinstance(url, str) or len(url) > 8192 or urlparse(url).scheme not in ('http', 'https') or not urlparse(url).hostname:
            raise ValueError('Only HTTP(S) URLs can be opened')
        with desktop_access():
            subprocess.run(['xdg-open', url], capture_output=True, timeout=15, check=True)
        return result({'opened': True})
    if name == 'send_chat_message':
        text = args.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > 100000:
            raise ValueError('Chat delivery requires 1–100000 text characters')
        return result({'dantMessage': {'text': text}})
    if name == 'react_message':
        message_id, emoji = args.get('messageId'), args.get('emoji')
        if (not isinstance(message_id, str) or not message_id or len(message_id) > 128 or
                'emoji' not in args or (emoji is not None and
                (not isinstance(emoji, str) or not emoji or len(emoji) > 64 or any(char.isspace() or ord(char) < 32 for char in emoji)))):
            raise ValueError('Reaction requires a real user message ID and one emoji or null')
        # This MCP process has no conversation Store. The owned-turn result is
        # validated by Engine with the shared Unicode emoji validator before save.
        return result({'dantReaction': {'messageId': message_id, 'emoji': emoji}})
    if name == 'create_voice_message':
        return result({'voiceFile': create_voice(args.get('text'), output_dir, args.get('language'))})
    raise ValueError('Unknown dant desktop tool')

def dispatch(message, output_dir):
    method, identifier = message.get('method'), message.get('id')
    if identifier is None:
        return None
    if method == 'initialize':
        value = {'protocolVersion': message.get('params', {}).get('protocolVersion', '2024-11-05'), 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'dant_desktop', 'version': '0.1.0'}}
    elif method == 'ping':
        value = {}
    elif method == 'tools/list':
        value = {'tools': TOOLS}
    elif method == 'tools/call':
        parameters = message.get('params', {})
        try:
            value = invoke(parameters.get('name'), parameters.get('arguments', {}), output_dir)
        except Exception as error:
            value = {'content': [{'type': 'text', 'text': str(error)}], 'isError': True}
    else:
        return {'jsonrpc': '2.0', 'id': identifier, 'error': {'code': -32601, 'message': 'Unsupported method'}}
    return {'jsonrpc': '2.0', 'id': identifier, 'result': value}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', required=True)
    options = parser.parse_args()
    os.environ.setdefault('DISPLAY', ':0')
    for raw in iter(lambda: sys.stdin.buffer.readline(2 * 1024 * 1024 + 1), b''):
        if len(raw) > 2 * 1024 * 1024:
            break
        try:
            response = dispatch(json.loads(raw), pathlib.Path(options.output_dir))
            if response is not None:
                print(json.dumps(response, ensure_ascii=False), flush=True)
        except (ValueError, TypeError):
            print(json.dumps({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Invalid MCP message'}}), flush=True)
