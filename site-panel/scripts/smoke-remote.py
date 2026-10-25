#!/usr/bin/env python3
"""Explicitly opt-in smoke test against an EMPTY Debian 12 node.
Installs software if --install is supplied and leaves one test site on the node.
Uses an isolated temporary panel database; no credentials are printed or committed.
"""
import argparse
import http.cookiejar
import json
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--host', required=True)
p.add_argument('--ssh-key', required=True)
p.add_argument('--fingerprint', required=True, action='append', help='Previously verified SSH fingerprint; repeat for multiple host keys')
p.add_argument('--ssh-port', type=int, default=22)
p.add_argument('--http-port', type=int, default=18080)
p.add_argument('--allow-node-changes', action='store_true', required=True)
p.add_argument('--install', action='store_true')
a = p.parse_args()
project = Path(__file__).resolve().parent.parent
with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
base = f'http://127.0.0.1:{port}'
csrf = ''
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def api(path, value=None, raw=None):
    data = raw if raw is not None else None if value is None else json.dumps(value).encode()
    headers = {'X-CSRF-Token': csrf}
    if value is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(base + '/api' + path, data=data, headers=headers)
    with opener.open(request, timeout=60) as r:
        return json.load(r)

def wait_task(task_id, remote=False):
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        tasks = api('/tasks')
        task = next(t for t in tasks if t['id'] == task_id)
        if remote and task['step'] not in ('prepare',) and task['status'] not in ('succeeded', 'failed'):
            task = api(f'/tasks/{task_id}/refresh', {})
        if task['status'] == 'succeeded':
            return task
        if task['status'] in ('failed', 'needs_attention'):
            raise RuntimeError(json.dumps(task, ensure_ascii=False))
        time.sleep(2)
    raise TimeoutError('Task did not finish')

with tempfile.TemporaryDirectory(prefix='site-panel-smoke-') as data:
    log_path = Path(data) / 'panel.log'
    with log_path.open('wb') as log:
        proc = subprocess.Popen([str(project/'bin/site-panel'), '-listen', f'127.0.0.1:{port}', '-data', data, '-ssh-key', str(Path(a.ssh_key).expanduser()), '-node-binary', str(project/'bin/site-panel-node')], cwd=project, stdout=log, stderr=log)
        try:
            for _ in range(50):
                try:
                    api('/session')
                    break
                except (OSError, urllib.error.URLError):
                    time.sleep(.1)
            csrf = api('/setup', {'password': secrets.token_urlsafe(24)})['csrf']
            fp = api('/nodes/probe', {'host': a.host, 'port': a.ssh_port, 'user': 'root'})['fingerprint']
            if fp not in a.fingerprint:
                raise RuntimeError('Server fingerprint does not match trusted fingerprint(s)')
            n = api('/nodes', {'name': '真实服务器部署测试', 'host': a.host, 'port': a.ssh_port, 'user': 'root', 'password': '', 'fingerprint': fp, 'note': 'isolated smoke test'})
            if a.install:
                task = api(f"/nodes/{n['id']}/install", {})
                wait_task(task['task_id'])
                print('PASS: SSH automatic installation')
            print('Node status:', json.dumps(api(f"/nodes/{n['id']}/status"), ensure_ascii=False))
            site = api('/sites', {'name': 'Site Panel smoke test', 'node_id': n['id'], 'domains': [a.host], 'port': a.http_port})
            for revision in (1, 2):
                body = f'<!doctype html><meta charset="utf-8"><h1>Site Panel 部署成功</h1><p>revision {revision}</p>\n'.encode()
                api(f"/sites/{site['id']}/file?path=index.html", raw=body)
                task = api(f"/sites/{site['id']}/deploy", {})
                wait_task(task['task_id'], remote=True)
                with urllib.request.urlopen(f'http://{a.host}:{a.http_port}/', timeout=15) as r:
                    received = r.read()
                if received != body:
                    raise RuntimeError('Public page does not match uploaded source')
                print(f'PASS: deployment {revision}, public HTTP content matches')
            # Re-submitting a completed task must not run the operation again.
            subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-i', str(Path(a.ssh_key).expanduser()), '-p', str(a.ssh_port), f'root@{a.host}', '/usr/local/libexec/site-panel-node submit ' + task['task_id']], check=True, stdout=subprocess.DEVNULL, timeout=30)
            assert api(f"/tasks/{task['task_id']}/refresh", {})['status'] == 'succeeded'
            print('PASS: repeated submission keeps completed result')
            # An invalid new deployment must not disturb the working site.
            empty = api('/sites', {'name': 'empty negative test', 'node_id': n['id'], 'domains': ['empty-test.invalid'], 'port': a.http_port + 1})
            bad = api(f"/sites/{empty['id']}/deploy", {})
            try:
                wait_task(bad['task_id'], remote=True)
                raise AssertionError('Empty site unexpectedly deployed')
            except RuntimeError as error:
                if 'index.html' not in str(error):
                    raise
            with urllib.request.urlopen(f'http://{a.host}:{a.http_port}/', timeout=15) as r:
                assert r.read() == body
            print('PASS: missing index.html fails and existing site stays available')
            print('Test URL:', f'http://{a.host}:{a.http_port}/')
            print('Remote site ID:', site['id'])
            print('NOTE: temporary local test source is removed; remote demo remains. Not a production site.')
        except Exception:
            print(log_path.read_text())
            raise
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
