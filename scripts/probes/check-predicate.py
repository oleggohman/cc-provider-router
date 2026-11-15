#!/usr/bin/env python3
"""Evaluates the proposed classifier predicate (docs/design-notes.md, "Answer
in place: spike") over every request the probe mod recorded, independently of
what the probe mod itself decided, and over synthetic variants of a recorded
classifier request.

usage: check-predicate.py <probe.jsonl>...
       check-predicate.py --observer [--provider-host <host:port>] <observer.jsonl>...

Prints each distinct request shape with the conditions it fails (none means
a match) and exits 1 when a request that is not the classifier's matches:
one whose system prompt does not open with the classifier's, or a variant.

With --observer it reads the fetch observer's record
(tests/observer-plugin) instead: it checks every line against the record
schema (exit 2 on a bad line, e.g. a header value or a beta token other than
the classifier's) and prints one JSON line per request with its kind, the
predicate conditions it fails and whether it names the shadow model or a
router-prefixed id. Kinds: `provider` (the --provider-host), `classifier`
(the predicate matches), `telemetry` (a non-engine request to
/api/event_logging/), `engine-other` (any other engine request), `other`.
scripts/automode-check.sh asserts on these lines.
"""
import copy
import json
import re
import sys
from urllib.parse import unquote, urlparse

URL = 'https://api.anthropic.com/v1/messages?beta=true'
BETA = re.compile(r'^auto-mode-classifier-\d{4}-\d{2}-\d{2}$')
ALLOWED = {'max_tokens', 'messages', 'metadata', 'model', 'stop_sequences', 'system', 'thinking'}
PREFIX = re.compile(r'^(anthropic|openai|zai|xai|custom)(:|$)')
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


OBSERVER_KEYS = {'t', 'seq', 'url', 'method', 'model', 'bodyKeys', 'bodyType', 'origin', 'headers', 'agent', 'classifierBeta'}
OBSERVER_REQUIRED = OBSERVER_KEYS - {'model', 'bodyKeys'}
PREFIXED_IN_URL = re.compile(r'(anthropic|openai|zai|xai|custom)(:|%3a)', re.I)


def schema_errors(r):
    out = []
    if not isinstance(r, dict):
        return ['not an object']
    out += [f'missing {k}' for k in sorted(OBSERVER_REQUIRED - r.keys())]
    out += [f'unknown key {k}' for k in sorted(r.keys() - OBSERVER_KEYS)]
    if not isinstance(r.get('url'), str) or not isinstance(r.get('method'), str):
        out.append('url/method not strings')
    if not isinstance(r.get('origin'), dict):
        out.append('origin not an object')
    if r.get('agent') not in ('main', 'subagent'):
        out.append('agent not main/subagent')
    beta = r.get('classifierBeta')
    if beta is not None and not (isinstance(beta, str) and BETA.match(beta)):
        out.append('classifierBeta holds something other than the classifier token')
    headers = r.get('headers')
    if not isinstance(headers, list) or any(not isinstance(h, dict) or not isinstance(h.get('name'), str) or set(h) - {'name', 'redacted'} for h in headers):
        out.append('headers must be a list of {name[, redacted]} (no values)')
    keys = r.get('bodyKeys')
    if keys is not None and not (isinstance(keys, list) and all(isinstance(k, str) for k in keys)):
        out.append('bodyKeys not a list of strings')
    return out


def as_probe(r):
    """An observer line in the probe record's shape, for fails()."""
    headers = {'anthropic-beta': r.get('classifierBeta') or ''}
    if r.get('agent') == 'subagent':
        headers['x-claude-code-agent-id'] = 'present'
    keys = r.get('bodyKeys') if r.get('bodyType') == 'string' and isinstance(r.get('bodyKeys'), list) else None
    return {'origin': r.get('origin'), 'method': r.get('method'), 'url': r.get('url'), 'headers': headers, 'keys': keys, 'model': r.get('model')}


def observer_main(args):
    host = None
    if args[:1] == ['--provider-host']:
        host, args = args[1], args[2:]
    broken = 0
    for path in args:
        for n, line in enumerate(open(path), 1):
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except ValueError:
                r = None
            errs = schema_errors(r) if r is not None else ['not JSON']
            if errs:
                broken += 1
                print(f'SCHEMA {path}:{n}: {"; ".join(errs)}', file=sys.stderr)
                continue
            url, model = r['url'], r.get('model')
            f = fails(as_probe(r))
            plugin = (r.get('origin') or {}).get('plugin')
            decoded = unquote(url)
            if host and urlparse(url).netloc == host:
                kind = 'provider'
            elif not f:
                kind = 'classifier'
            elif plugin != 'engine' and '/api/event_logging/' in urlparse(url).path:
                kind = 'telemetry'
            elif plugin == 'engine':
                kind = 'engine-other'
            else:
                kind = 'other'
            print(json.dumps({'seq': r.get('seq'), 'kind': kind, 'fails': f, 'origin': plugin, 'method': r.get('method'), 'url': url, 'model': model,
                              'agent': r.get('agent'), 'marker': r.get('classifierBeta') is not None,
                              'names_shadow': model == SHADOW or SHADOW in decoded,
                              'prefixed': (isinstance(model, str) and bool(PREFIX.match(model))) or bool(PREFIXED_IN_URL.search(decoded))}))
    sys.exit(2 if broken else 0)


if sys.argv[1:2] == ['--observer']:
    observer_main(sys.argv[2:])

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
