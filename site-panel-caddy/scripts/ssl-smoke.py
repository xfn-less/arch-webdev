#!/usr/bin/env python3
"""Explicit SSL integration on the existing test node/site, no file deployment.
Staging never enables an untrusted certificate. A production run enables :443
and preserves the site's original :18080 HTTP entry. Node identity is verified
by the existing OpenSSH known_hosts. Certificate private keys are never printed.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time

p=argparse.ArgumentParser()
p.add_argument('--production',action='store_true')
p.add_argument('--agree-terms',action='store_true',required=True)
p.add_argument('--task-id',help='resume querying an already submitted task')
a=p.parse_args()
os.umask(0o077)
root=Path(__file__).resolve().parents[1]
host='root@103.149.201.31'
ssh=['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',host]
site='1b72d9296477b99f8d8edd5b8a926603'
id=a.task_id or secrets.token_hex(16)
if len(id)!=32 or any(c not in '0123456789abcdef' for c in id):raise SystemExit('Invalid task ID')
req={'id':id,'operation':'ssl','site':{'id':site,'name':'测试下载站','domains':['103.149.201.31','panel-test.xfnss.top'],'port':18080},'ssl':{'domains':['panel-test.xfnss.top'],'agree_terms':True,'staging':not a.production,'node_ip':'103.149.201.31'}}
if not a.task_id:
 with tempfile.TemporaryDirectory(prefix='site-panel-ssl-') as tmp:
  path=Path(tmp)/'request.json';path.write_text(json.dumps(req))
  subprocess.run(ssh+['install -d -m 700 /var/lib/site-panel/tasks/'+id],check=True)
  subprocess.run(['scp','-q','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',str(path),host+':/var/lib/site-panel/tasks/'+id+'/request.json'],check=True)
  subprocess.run(ssh+['/usr/local/libexec/site-panel-node submit '+id],check=True)
print('SSL task:',id,'mode:','production' if a.production else 'staging',flush=True)
last=None
for _ in range(300):
 result=json.loads(subprocess.check_output(ssh+['/usr/local/libexec/site-panel-node task-status '+id],timeout=25))
 state=result['status']+'/'+result['step']
 if state!=last:print(state,flush=True);last=state
 if result['status'] in ('succeeded','failed','needs_attention'):
  (root/'data'/('ssl-production-task.json' if a.production else 'ssl-staging-task.json')).write_text(json.dumps({'request':req,'result':result},indent=2)+'\n')
  if result['status']!='succeeded':raise SystemExit(result.get('error') or 'SSL task failed')
  print('PASS:',state,flush=True);break
 time.sleep(3)
else:raise SystemExit('Result unknown; query the same task ID, do not submit another request')
