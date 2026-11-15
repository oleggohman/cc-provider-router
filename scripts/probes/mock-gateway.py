#!/usr/bin/env python3
"""Local Anthropic-Messages mock gateway (SSE), to see the engine's own
requests without any mod: run `claude` with ANTHROPIC_BASE_URL pointing here
and a fake ANTHROPIC_API_KEY, so nothing is billed and nothing reaches the
first-party API.

usage: mock-gateway.py <port> <logfile>

A request that carries the Agent tool and no tool result is answered with an
Agent call ("Reply with the single word PONG"); after the tool result with
GW-DONE; anything else (the subagent, the auto-mode classifier's side
request) with PONG. The reply carries no `safeguard_results`, so in auto
mode the engine falls back to its local classifier, whose request then
arrives here too.

With env GW_FAIL_MODEL=<substring>, a request whose model contains it gets
HTTP 529 (overloaded), which makes the engine retry and, with
`--fallback-model`, send the conversation again under the other model.

Every request is logged as one JSON line: path, model, body keys, header
names (no values except anthropic-beta and x-stainless-timeout), the start
of the system prompt.
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, LOG = int(sys.argv[1]), sys.argv[2]
FAIL = os.environ.get('GW_FAIL_MODEL', '')
AGENT = {'description': 'pong', 'prompt': 'Reply with the single word PONG', 'subagent_type': 'general-purpose'}


def sse(events):
    return ''.join(f'event: {e}\ndata: {json.dumps(d)}\n\n' for e, d in events).encode()


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(404, b'{}', 'application/json')

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('content-length', 0)) or 0)
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        system = body.get('system')
        sys_text = system if isinstance(system, str) else ' '.join(b.get('text', '') for b in (system or []) if isinstance(b, dict))
        flat = json.dumps(body.get('messages', []))
        had_tool = '"tool_result"' in flat
        tools = [t.get('name') for t in body.get('tools', []) if isinstance(t, dict)]
        with open(LOG, 'a') as f:
            f.write(json.dumps({
                't': round(time.time(), 3), 'path': self.path, 'model': body.get('model'), 'keys': sorted(body.keys()), 'n_tools': len(tools),
                'thread': body.get('thread'), 'max_tokens': body.get('max_tokens'), 'stop_sequences': body.get('stop_sequences'),
                'header_names': sorted(k.lower() for k in self.headers.keys()), 'anthropic_beta': self.headers.get('anthropic-beta'),
                'timeout': self.headers.get('x-stainless-timeout'), 'retry': self.headers.get('x-stainless-retry-count'),
                'system_start': sys_text[:200], 'had_tool': had_tool}) + '\n')
        if 'count_tokens' in self.path:
            return self._send(200, b'{"input_tokens": 10}', 'application/json')
        if FAIL and FAIL in str(body.get('model')):
            return self._send(529, json.dumps({'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'mock overload'}}).encode(), 'application/json')
        main = 'Agent' in tools
        if main and not had_tool:
            content, stop = [{'type': 'tool_use', 'id': 'toolu_gw_1', 'name': 'Agent', 'input': AGENT}], 'tool_use'
        elif main:
            content, stop = [{'type': 'text', 'text': 'GW-DONE'}], 'end_turn'
        else:
            content, stop = [{'type': 'text', 'text': 'PONG'}], 'end_turn'
        m = {'id': 'msg_gw', 'type': 'message', 'role': 'assistant', 'model': body.get('model') or 'm', 'content': [], 'stop_reason': None, 'stop_sequence': None,
             'usage': {'input_tokens': 1, 'output_tokens': 1}}
        if not body.get('stream'):
            m['content'], m['stop_reason'] = content, stop
            return self._send(200, json.dumps(m).encode(), 'application/json')
        ev = [('message_start', {'type': 'message_start', 'message': m})]
        for i, b in enumerate(content):
            if b['type'] == 'text':
                ev += [('content_block_start', {'type': 'content_block_start', 'index': i, 'content_block': {'type': 'text', 'text': ''}}),
                       ('content_block_delta', {'type': 'content_block_delta', 'index': i, 'delta': {'type': 'text_delta', 'text': b['text']}})]
            else:
                ev += [('content_block_start', {'type': 'content_block_start', 'index': i, 'content_block': {'type': 'tool_use', 'id': b['id'], 'name': b['name'], 'input': {}}}),
                       ('content_block_delta', {'type': 'content_block_delta', 'index': i, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(b['input'])}})]
            ev.append(('content_block_stop', {'type': 'content_block_stop', 'index': i}))
        ev += [('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None}, 'usage': {'output_tokens': 1}}), ('message_stop', {'type': 'message_stop'})]
        self._send(200, sse(ev), 'text/event-stream')


ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
