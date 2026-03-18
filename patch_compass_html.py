#!/usr/bin/env python3
"""
Patch radio.html — add compass.js script tag after hb9vqq-init.js

Run on wsprdaemon:
    sudo python3 patch_compass_html.py
"""
import shutil, datetime

TARGET = '/usr/local/share/ka9q-web/html/radio.html'

with open(TARGET) as f:
    s = f.read()

assert 'compass.js' not in s, 'Already patched'

OLD = '<script src="hb9vqq-init.js"></script>'
NEW = '<script src="hb9vqq-init.js"></script>\n<script src="compass.js"></script>'

assert OLD in s, 'hb9vqq-init.js script tag not found'
s = s.replace(OLD, NEW, 1)

ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
shutil.copy2(TARGET, TARGET + '.' + ts + '.bak')
with open(TARGET, 'w') as f:
    f.write(s)
print('OK — compass.js added to radio.html')
