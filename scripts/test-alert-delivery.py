import datetime
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

# Local-only integration smoke: ALERTMANAGER_BIN may point at a pinned binary.
root = Path(__file__).resolve().parents[1]
alertmanager_bin = os.environ.get('ALERTMANAGER_BIN', 'alertmanager')
received = []

class Receiver(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        received.append((self.path, body))
        self.send_response(204)
        self.end_headers()
    def log_message(self, *args):
        pass

receiver = http.server.HTTPServer(('127.0.0.1', 0), Receiver)
threading.Thread(target=receiver.serve_forever, daemon=True).start()
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    am_port = sock.getsockname()[1]

with tempfile.TemporaryDirectory(prefix='circle-alert-smoke-') as temp:
    temp = Path(temp)
    config = (root / 'monitoring/alertmanager/alertmanager.yml').read_text()
    for file in ['discord.url', 'heartbeat.url', 'heartbeat-fail.url']:
        target = temp / file
        target.write_text(f'http://127.0.0.1:{receiver.server_port}/{file}')
        config = config.replace('/etc/alertmanager/' + file, str(target))
    assert '/etc/alertmanager/' not in config, 'Unmapped receiver credential file'
    # Speed up only this disposable copy. Production timings remain unchanged.
    config = config.replace('group_wait: 30s','group_wait: 1s').replace('group_wait: 10s','group_wait: 1s').replace('group_interval: 5m','group_interval: 1s')
    (temp / 'alertmanager.yml').write_text(config)
    with (temp / 'alertmanager.log').open('w') as log:
        process = subprocess.Popen([alertmanager_bin, '--config.file='+str(temp/'alertmanager.yml'), '--storage.path='+str(temp/'data'), f'--web.listen-address=127.0.0.1:{am_port}', '--cluster.listen-address='], stdout=log, stderr=subprocess.STDOUT)
        try:
            base = f'http://127.0.0.1:{am_port}'
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base+'/-/ready', timeout=1) as response:
                        assert response.status == 200
                    break
                except OSError:
                    assert process.poll() is None, (temp/'alertmanager.log').read_text()
                    time.sleep(.1)
            else:
                raise RuntimeError('Alertmanager did not become ready')

            now = datetime.datetime.now(datetime.timezone.utc)
            alerts = [{'labels':{'alertname':name,'severity':severity,'instance':'local-smoke','pool':'http'}, 'annotations':{'summary':'LOCAL TEST ONLY'},'startsAt':(now-datetime.timedelta(seconds=1)).isoformat(),'endsAt':(now+datetime.timedelta(minutes=2)).isoformat()} for name,severity in [('GatewayCapacityRejecting','critical'),('GatewayCapacityNearLimit','warning')]]
            def post_alerts():
                req = urllib.request.Request(base+'/api/v2/alerts', data=json.dumps(alerts).encode(),headers={'Content-Type':'application/json'},method='POST')
                with urllib.request.urlopen(req,timeout=3) as response:
                    assert response.status == 200
            post_alerts()
            for _ in range(150):
                if len(received)>=2: break
                time.sleep(.1)
            assert len(received)>=2, (received,(temp/'alertmanager.log').read_text())
            bodies = [json.dumps(body, ensure_ascii=False) for path,body in received]
            assert any('CRITICAL' in body and 'GatewayCapacityRejecting' in body for body in bodies), bodies
            assert any('GatewayCapacityNearLimit' in body for body in bodies), bodies
            firing = len(received)
            for alert in alerts:
                alert['endsAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            post_alerts()
            for _ in range(150):
                if len(received)>=firing+2: break
                time.sleep(.1)
            resolved = received[firing:]
            assert len(resolved)>=2, (received,(temp/'alertmanager.log').read_text())
            for name in ['GatewayCapacityRejecting','GatewayCapacityNearLimit']:
                assert any(name in json.dumps(body) and ('Resolved' in json.dumps(body) or 'RESOLVED' in json.dumps(body)) for path,body in resolved), resolved
            print(json.dumps({'local_alertmanager_pipeline':'passed','firing_deliveries':firing,'resolved_deliveries':len(resolved),'external_requests':0}))
        finally:
            process.terminate()
            process.wait(timeout=10)
            receiver.shutdown()
