#!/usr/bin/env python3
"""Evaluates the proposed classifier predicate (docs/design-notes.md, "Answer
in place: spike") over every request the probe mod recorded, independently of
what the probe mod itself decided, and over synthetic variants of a recorded
classifier request.

usage: check-predicate.py <probe.jsonl>...

Prints each distinct request shape with the conditions it fails (none means
a match) and exits 1 when a request that is not the classifier's matches:
one whose system prompt does not open with the classifier's, or a variant.
"""
import copy
import json
import re
import sys

URL = 'https://api.anthropic.com/v1/messages?beta=true'
BETA = re.compile(r'^auto-mode-classifier-\d{4}-\d{2}-\d{2}$')
ALLOWED = {'max_tokens', 'messages', 'metadata', 'model', 'stop_sequences', 'system', 'thinking'}
PREFIX = re.compile(r'^(anthropic|openai|zai|custom)(:|$)')
SHADOW = 'provider-router-shadow'
CLASSIFIER_SYSTEM = 'You are a security monitor for autonomous AI coding agents.'


def fails(r):
    out = []
    if (r.get('origin') or {}).get('plugin') != 'engine':
        out.append('origin')
    if r.get('method') != 'POST':
        out.append('method')
    if r.get('url') != URL:
        out.append('url')
    headers = r.get('headers') or {}
    if not any(BETA.match(b.strip()) for b in str(headers.get('anthropic-beta', '')).split(',')):
        out.append('marker')
    if 'x-claude-code-agent-id' in headers:
        out.append('agent-header')
    keys = r.get('keys')
    if not isinstance(keys, list):
        return out + ['body']
    model = r.get('model')
    if not isinstance(model, str) or not model or model == SHADOW or PREFIX.match(model):
        out.append('model')
    out += [f'key:{k}' for k in keys if k not in ALLOWED]
    return out


def is_classifier(r):
    return any(CLASSIFIER_SYSTEM in str(s) for s in (r.get('system') or [])) if isinstance(r.get('system'), list) else False


def variants(base):
    def v(name, change):
        r = copy.deepcopy(base)
        change(r)
        return name, r
    yield v('non-engine origin', lambda r: r.update(origin={'plugin': 'other-plugin', 'tier': 'user'}))
    yield v('GET', lambda r: r.update(method='GET'))
    yield v('count_tokens path', lambda r: r.update(url='https://api.anthropic.com/v1/messages/count_tokens?beta=true'))
    yield v('other host', lambda r: r.update(url='https://api.anthropic.com.example.org/v1/messages?beta=true'))
    yield v('shadow model in the URL', lambda r: r.update(url=URL + '&m=' + SHADOW))
    yield v('no classifier beta', lambda r: r['headers'].update({'anthropic-beta': 'claude-code-20250219,claude-code-side-query-2026-09-29'}))
    yield v('beta as a substring only', lambda r: r['headers'].update({'anthropic-beta': 'x-auto-mode-classifier-2026-07-16-y'}))
    yield v('agent header', lambda r: r['headers'].update({'x-claude-code-agent-id': 'a1'}))
    yield v('shadow model', lambda r: r.update(model=SHADOW))
    yield v('prefixed model', lambda r: r.update(model='custom:mock:m'))
    yield v('malformed prefix', lambda r: r.update(model='openai:'))
    yield v('with tools', lambda r: r.update(keys=r['keys'] + ['tools']))
    yield v('with thread', lambda r: r.update(keys=r['keys'] + ['thread']))
    yield v('with stream', lambda r: r.update(keys=r['keys'] + ['stream']))
    yield v('with safeguards', lambda r: r.update(keys=r['keys'] + ['safeguards']))
    yield v('with output_config', lambda r: r.update(keys=r['keys'] + ['output_config']))
    yield v('unparseable body', lambda r: r.update(keys=None))


shapes, bad, base = {}, 0, None
for path in sys.argv[1:]:
    for line in open(path):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get('ev') != 'fetch':
            continue
        f = fails(r)
        if not f and base is None:
            base = r
        betas = [b for b in str((r.get('headers') or {}).get('anthropic-beta', '')).split(',') if 'auto-mode' in b or 'side-query' in b]
        system = r.get('system')
        opening = next((str(s)[:44] for s in system if 'billing-header' not in str(s)), '') if isinstance(system, list) else ''
        key = ((r.get('origin') or {}).get('plugin'), r.get('url'), r.get('model'), ','.join(r.get('keys') or []), (r.get('thread') or {}).get('type', '-'),
               '+'.join(betas), opening, ','.join(f) or 'MATCH', is_classifier(r))
        shapes[key] = shapes.get(key, 0) + 1

for key, n in sorted(shapes.items(), key=lambda kv: str(kv[0])):
    wrong = key[7] == 'MATCH' and not key[8]
    bad += wrong
    print(f"{n:5d}  {'!! ' if wrong else ''}{key[7]:<8.60} origin={key[0]} model={key[2]} thread={key[4]} betas={key[5]}\n         url={key[1]}\n         keys={key[3]}\n         system={key[6]!r}")

if base is None:
    print('no matching request recorded: nothing to derive variants from')
else:
    print('\nvariants of a recorded classifier request (each must fail):')
    for name, r in variants(base):
        f = fails(r)
        bad += not f
        print(f"  {'!! MATCH' if not f else 'fails'}  {name}: {','.join(f)}")
sys.exit(1 if bad else 0)
