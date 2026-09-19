#!/usr/bin/env python3
"""Provision a pinned private registry snapshot during environment setup only."""
from __future__ import annotations
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import urllib.request

FILES = ('graph.json', 'AGENTS.md', 'tools/radar.py')

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')

def sha(data):
    return hashlib.sha256(data).hexdigest()

def verify(root):
    m = json.loads((root / 'snapshot-manifest.json').read_text())
    if not re.fullmatch(r'[0-9a-f]{40}', m.get('registry_commit', '')):
        raise ValueError('Invalid registry commit')
    for name in FILES:
        if sha((root / name).read_bytes()) != m['files'][name]:
            raise ValueError('Snapshot integrity failure')
    return m

def write_manifest(root, m):
    target = root / 'snapshot-manifest.json'
    tmp = root / 'snapshot-manifest.json.tmp'
    tmp.write_text(json.dumps(m, indent=2) + '\n')
    os.replace(tmp, target)

def refresh(dest, repository, commit, fetch):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Invalid repository')
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('An exact 40-character commit is required')
    dest = Path(dest).absolute()
    # Existing snapshots must verify before replacement or fallback.
    cached = verify(dest) if dest.exists() else None
    if cached and cached['repository'] != repository:
        raise ValueError('Cached repository identity mismatch')
    dest.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.knowledge-stage-', dir=dest.parent))
    try:
        contents = {name: fetch(name) for name in FILES}
        graph = json.loads(contents['graph.json'])
        if graph.get('schema_version') != '1.0' or not isinstance(graph.get('nodes'), list):
            raise ValueError('Invalid graph structure')
        manifest = {'schema_version':'1.0', 'repository':repository,
                    'registry_commit':commit, 'graph_updated_at':graph.get('updated_at'),
                    'fetched_at':now(), 'refresh_status':'pinned-snapshot',
                    'files':{name:sha(data) for name, data in contents.items()}}
        for name, data in contents.items():
            p = stage / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            p.chmod(0o444)
        write_manifest(stage, manifest)
        backup = dest.with_name(dest.name + '.last-known')
        if backup.exists():
            shutil.rmtree(backup)
        if dest.exists():
            dest.rename(backup)
        try:
            stage.rename(dest)
        except OSError:
            if backup.exists() and not dest.exists():
                backup.rename(dest)
            raise
        return manifest
    except Exception as exc:
        if cached and dest.exists():
            cached.update(refresh_status='cached-offline', refresh_failed_at=now(),
                          requested_commit=commit, refresh_error_type=type(exc).__name__)
            write_manifest(dest, cached)
            return cached
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repository', required=True)
    p.add_argument('--commit', required=True)
    p.add_argument('--dest', type=Path, default=Path('.knowledge'))
    a = p.parse_args()
    token = os.environ.pop('LAB_KNOWLEDGE_READ_TOKEN', None)
    def fetch(name):
        if not token:
            raise PermissionError('Setup-only read token unavailable')
        url = f'https://api.github.com/repos/{a.repository}/contents/{name}?ref={a.commit}'
        req = urllib.request.Request(url, headers={
            'Authorization':'Bearer ' + token, 'Accept':'application/vnd.github+json',
            'User-Agent':'lab-knowledge-setup'})
        with urllib.request.urlopen(req, timeout=30) as response:
            obj = json.load(response)
        if obj.get('encoding') != 'base64':
            raise ValueError('Unexpected response encoding')
        data = base64.b64decode(obj['content'])
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if blob != obj['sha']:
            raise ValueError('Git blob integrity failure')
        return data
    try:
        m = refresh(a.dest, a.repository, a.commit, fetch)
        print(json.dumps({'status':m['refresh_status'], 'registry_commit':m['registry_commit'],
                          'graph_sha256':m['files']['graph.json']}))
        return 0 if m['refresh_status'] == 'pinned-snapshot' else 3
    except Exception as exc:
        # Do not echo request URLs, headers, secret values or server response bodies.
        print(json.dumps({'status':'unavailable', 'error_type':type(exc).__name__}))
        return 2

if __name__ == '__main__':
    raise SystemExit(main())
