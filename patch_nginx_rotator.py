#!/usr/bin/env python3
"""
Patch /etc/nginx/sites-available/rx888.conf
Add /api/rotator/ → localhost:9376 location to all server blocks.

Run on wsprdaemon:
    sudo python3 patch_nginx_rotator.py
"""
import shutil, datetime

TARGET = '/etc/nginx/sites-available/rx888.conf'

ROTATOR_LOCATION = '''    location /api/rotator/ {
        proxy_pass http://127.0.0.1:9376/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        add_header Access-Control-Allow-Origin *;
        add_header Cache-Control no-cache;
    }
'''

with open(TARGET) as f:
    s = f.read()

assert '/api/rotator/' not in s, 'Already patched'

# Add before every /api/rmnoise/ location block
OLD = '    location /api/rmnoise/ {'
NEW = ROTATOR_LOCATION + '    location /api/rmnoise/ {'

count = s.count(OLD)
assert count > 0, '/api/rmnoise/ location not found'
s = s.replace(OLD, NEW)
print(f'Added /api/rotator/ to {count} server block(s)')

ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
shutil.copy2(TARGET, TARGET + '.' + ts + '.bak')
with open(TARGET, 'w') as f:
    f.write(s)
print('OK — nginx config updated')
