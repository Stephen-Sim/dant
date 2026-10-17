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
from desktop import act, screenshot
from control import desktop_access
from voice_message import create as create_voice

def tool(name, description, properties, required=()):
    return {'name': name, 'description': description, 'inputSchema': {'type': 'object', 'properties': properties, 'required': list(required), 'additionalProperties': False}}

NUMBER = {'type': 'integer', 'minimum': 0, 'maximum': 4096}
TEXT = {'type': 'string'}
TOOLS = [
    tool('screenshot', 'Observe the current VM desktop.', {}),
    tool('click', 'Click the VM desktop at screenshot coordinates.', {'x': NUMBER, 'y': NUMBER, 'button': {'type': 'integer', 'enum': [0, 1, 2]}}, ['x', 'y']),
    tool('drag', 'Drag on the VM desktop.', {'startX': NUMBER, 'startY': NUMBER, 'endX': NUMBER, 'endY': NUMBER, 'button': {'type': 'integer', 'enum': [0, 1, 2]}}, ['startX', 'startY', 'endX', 'endY']),
    tool('key', 'Press a key chord such as ctrl+l or Return.', {'key': TEXT}, ['key']),
    tool('type_text', 'Paste Unicode text into the active VM application.', {'text': TEXT}, ['text']),
    tool('scroll', 'Scroll the active VM application; negative is up.', {'delta': {'type': 'integer', 'minimum': -12, 'maximum': 12}}, ['delta']),
    tool('open_url', 'Open an HTTP or HTTPS page in the VM browser.', {'url': TEXT}, ['url']),
    tool('send_chat_message', 'Explicitly deliver text or links to the current chat. The application validates and publishes this result.', {'text': TEXT}, ['text']),
    tool('create_voice_message', 'Create a real local WAV file for attachment delivery.', {'text': TEXT, 'language': {'type': 'string', 'enum': ['zh', 'en']}}, ['text']),
]

def result(value):
    return {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}], 'structuredContent': value, 'isError': False}

def invoke(name, args, output_dir):
    if not isinstance(args, dict):
        raise ValueError('Tool arguments must be an object')
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
