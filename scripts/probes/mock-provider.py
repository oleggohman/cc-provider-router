#!/usr/bin/env python3
"""Local OpenAI-compatible mock provider for the probes (no keys, no network).

usage: mock-provider.py <port> <logfile> [<outside-dir>]

POST <any path ending in /chat/completions>: answers by scenario, named by
`scenario=<name>[:<arg>]` in the LAST message when that is a user message
(the fresh prompt). Any other request (after a tool result, a task
notification, a prompt with no scenario) gets the text MOCK-DONE, so a
session can never loop. Every tool call it emits is harmless:

  agent     main loop: one Agent call ("Reply with the single word PONG"),
            then MOCK-DONE after the tool result
  agent2    like agent, with a different description and prompt wording
            (same stop reason and block count: the delivery comparison)
  two       one reply with two tool calls: Agent and the outside Bash touch
  bash      Bash `touch <outside-dir>/marker.txt`, then MOCK-DONE
  cmd       Bash running the command in env MOCK_CMD, then MOCK-DONE
  text      the text MOCK-TEXT
  ws        text with leading/trailing whitespace and a tool call whose
            arguments have unsorted keys and odd spacing
  slow:<s>  waits <s> seconds, then the text MOCK-SLOW
  http:<n>  answers HTTP <n> with an error body
  usage:<n> the text MOCK-USAGE with prompt_tokens <n>
  long:<n>  a text of about <n> characters, usage of about <n>/4 tokens

A request whose first user text asks for "the single word PONG" (the
subagent started by `agent`) is answered PONG. A request whose system prompt
contains MOCKWORKER (a routed subagent, see the README) and that carries no
fresh scenario emits the outside Bash touch, then `SUB-SAW: <tool result>`.
With env MOCK_PONG_HTTP=<n> the PONG subagent's request fails with HTTP <n>
(what a parent agent sees of a routed subagent's error reply).

GET <any path>: a one-line shell script that writes a file in <outside-dir>
(the target of a "download and run" command in the classifier-denial probe).
At most MOCK_TOOL_CAP (default 6) tool calls are emitted per minute.

POST <path ending in /slow?s=<n>>: answers `{}` after n seconds.
Every request is logged as one JSON line (no header values).
"""
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1])
LOG = sys.argv[2]
OUTSIDE = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.abspath(LOG)), 'outside')
MARKER = os.path.join(OUTSIDE, 'marker.txt')
CAP = int(os.environ.get('MOCK_TOOL_CAP', '6'))
RECENT = []


def log(rec):
    rec['t'] = round(time.time(), 3)
    with open(LOG, 'a') as f:
        f.write(json.dumps(rec) + '\n')


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return ' '.join(str(b.get('text', '')) for b in content if isinstance(b, dict))
    return ''


def tool_call(cid, name, args, raw=None):
    return {'id': cid, 'type': 'function', 'function': {'name': name, 'arguments': raw if raw is not None else json.dumps(args)}}


AGENT = {'description': 'pong', 'prompt': 'Reply with the single word PONG', 'subagent_type': 'general-purpose'}
AGENT2 = {'description': 'ping', 'prompt': 'Reply with the single word PONG, please', 'subagent_type': 'general-purpose'}


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        out = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):
        # /script.sh: what the `cmd` scenario's "download and run" command
        # would run if the classifier let it through. It only writes a file in
        # the outside directory this mock owns.
        log({'get': self.path})
        out = ('echo ran > ' + os.path.join(OUTSIDE, 'script-ran.txt') + '\n').encode()
        self.send_response(200)
        self.send_header('content-type', 'text/plain')
        self.send_header('content-length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('content-length', 0)) or 0)
        url = urlparse(self.path)
        if url.path.endswith('/slow'):
            s = float(parse_qs(url.query).get('s', ['1'])[0])
            log({'slow': s})
            time.sleep(s)
            return self._send(200, {})
        try:
            body = json.loads(raw or b'{}')
        except Exception:
            body = {}
        msgs = body.get('messages', [])
        system = ' '.join(text_of(m.get('content')) for m in msgs if m.get('role') == 'system')
        users = [text_of(m.get('content')) for m in msgs if m.get('role') == 'user']
        tool_texts = [text_of(m.get('content')) for m in msgs if m.get('role') == 'tool']
        # The scenario fires once: on the request whose newest scenario-bearing
        # user message has no assistant or tool message after it.
        at = max((i for i, m in enumerate(msgs) if m.get('role') == 'user' and 'scenario=' in text_of(m.get('content'))), default=-1)
        answered = any(m.get('role') in ('assistant', 'tool') for m in msgs[at + 1:])
        found = re.findall(r'scenario=([a-z0-9]+)(?::([0-9]+))?', text_of(msgs[at].get('content'))) if at >= 0 else []
        scenario, arg = found[-1] if found and not answered else ('done', '')
        worker = 'MOCKWORKER' in system
        after_tool = bool(tool_texts)
        pong = bool(users) and 'single word PONG' in users[0] and 'scenario=' not in users[0]
        # Belt and braces against a looping session: at most CAP tool calls a minute.
        now = time.time()
        RECENT[:] = [t for t in RECENT if now - t < 60]
        capped = len(RECENT) >= CAP
        if capped:
            scenario, worker = 'done', False
        log({'path': url.path, 'model': body.get('model'), 'scenario': scenario, 'arg': arg, 'worker': worker, 'pong': pong, 'after_tool': after_tool, 'capped': capped,
             'n_messages': len(msgs), 'n_tools': len(body.get('tools', [])), 'header_names': sorted(k.lower() for k in self.headers.keys()),
             'system_start': system[:70], 'tool_text': [t[:300] for t in tool_texts[-2:]]})
        usage = {'prompt_tokens': 11, 'completion_tokens': 7}
        msg, fin = {'role': 'assistant', 'content': 'MOCK-DONE'}, 'stop'
        touch = {'command': 'touch ' + MARKER, 'description': 'touch marker'}
        if worker and scenario == 'done':
            if after_tool:
                msg = {'role': 'assistant', 'content': 'SUB-SAW: ' + ' | '.join(t[:300] for t in tool_texts)}
            else:
                msg, fin = {'role': 'assistant', 'content': None, 'tool_calls': [tool_call('call_w_1', 'Bash', touch)]}, 'tool_calls'
        elif pong:
            if os.environ.get('MOCK_PONG_HTTP'):
                return self._send(int(os.environ['MOCK_PONG_HTTP']), {'error': {'message': 'mock provider failure', 'type': 'mock_error'}})
            msg = {'role': 'assistant', 'content': 'PONG'}
        elif scenario in ('agent', 'agent2'):
            msg, fin = {'role': 'assistant', 'content': None, 'tool_calls': [tool_call('call_mock_1', 'Agent', AGENT if scenario == 'agent' else AGENT2)]}, 'tool_calls'
        elif scenario == 'two':
            msg, fin = {'role': 'assistant', 'content': None, 'tool_calls': [tool_call('call_mock_1', 'Agent', AGENT), tool_call('call_mock_2', 'Bash', touch)]}, 'tool_calls'
        elif scenario == 'bash':
            msg, fin = {'role': 'assistant', 'content': None, 'tool_calls': [tool_call('call_mock_1', 'Bash', touch)]}, 'tool_calls'
        elif scenario == 'cmd':
            cmd = {'command': os.environ.get('MOCK_CMD', 'true'), 'description': 'run the probe command'}
            msg, fin = {'role': 'assistant', 'content': None, 'tool_calls': [tool_call('call_mock_1', 'Bash', cmd)]}, 'tool_calls'
        elif scenario == 'ws':
            rawargs = '{ "description":"touch marker" ,\n  "command": "touch ' + MARKER + '"}'
            msg, fin = {'role': 'assistant', 'content': '  MOCK  WS \n\n', 'tool_calls': [tool_call('call_mock_1', 'Bash', None, rawargs)]}, 'tool_calls'
        elif scenario == 'text':
            msg = {'role': 'assistant', 'content': 'MOCK-TEXT'}
        elif scenario == 'slow':
            time.sleep(int(arg or 1))
            msg = {'role': 'assistant', 'content': 'MOCK-SLOW'}
        elif scenario == 'http':
            return self._send(int(arg or 500), {'error': {'message': 'mock provider failure', 'type': 'mock_error'}})
        elif scenario == 'usage':
            msg = {'role': 'assistant', 'content': 'MOCK-USAGE'}
            usage = {'prompt_tokens': int(arg or 0), 'completion_tokens': 7}
        elif scenario == 'long':
            n = int(arg or 1000)
            msg = {'role': 'assistant', 'content': ('lorem ipsum dolor sit amet ' * (n // 27 + 1))[:n]}
            usage = {'prompt_tokens': 11, 'completion_tokens': n // 4}
        if msg.get('tool_calls'):
            RECENT.append(now)
        self._send(200, {'id': 'chatcmpl-mock', 'object': 'chat.completion', 'model': 'mock-model-1', 'choices': [{'index': 0, 'message': msg, 'finish_reason': fin}], 'usage': usage})


os.makedirs(OUTSIDE, exist_ok=True)
ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
