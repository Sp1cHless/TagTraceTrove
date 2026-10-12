import json, socket, base64, struct, sys, urllib.request, os
expr_path, out_path = sys.argv[1], sys.argv[2]
expr = open(expr_path, encoding='utf-8').read()
targets = json.load(urllib.request.urlopen('http://127.0.0.1:9222/json'))
page = [t for t in targets if t['type'] == 'page'][0]
key = base64.b64encode(os.urandom(16)).decode()
s = socket.create_connection(('127.0.0.1', 9222))
req = (f"GET {page['webSocketDebuggerUrl'].split('9222')[1]} HTTP/1.1\r\nHost: 127.0.0.1:9222\r\nUpgrade: websocket\r\n"
       f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
s.sendall(req.encode())
resp = b''
while b'\r\n\r\n' not in resp: resp += s.recv(4096)
def send(msg):
    payload = json.dumps(msg).encode()
    header = bytearray([0x81]); n = len(payload)
    if n < 126: header.append(0x80 | n)
    elif n < 65536: header.append(0x80 | 126); header += struct.pack('>H', n)
    else: header.append(0x80 | 127); header += struct.pack('>Q', n)
    mask = os.urandom(4); header += mask
    s.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
def recv():
    hdr = s.recv(2)
    if len(hdr) < 2: return None
    n = hdr[1] & 0x7f
    if n == 126: n = struct.unpack('>H', s.recv(2))[0]
    elif n == 127: n = struct.unpack('>Q', s.recv(8))[0]
    data = b''
    while len(data) < n: data += s.recv(n - len(data))
    return json.loads(data.decode('utf-8', errors='replace'))
send({"id": 1, "method": "Runtime.evaluate", "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}})
while True:
    m = recv()
    if m is None: break
    if m.get('id') == 1:
        r = m.get('result', {})
        if 'exceptionDetails' in r:
            open(out_path, 'w', encoding='utf-8').write('EXC ' + json.dumps(r['exceptionDetails'])[:2000])
        else:
            value = r.get('result', {}).get('value')
            open(out_path, 'w', encoding='utf-8').write(value if isinstance(value, str) else json.dumps(value))
        break
