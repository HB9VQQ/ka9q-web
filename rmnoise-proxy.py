#!/usr/bin/env python3
"""
RMNoise credentials proxy for ka9q-web HB9VQQ fork.
Handles CORS by proxying rmnoise.com login + token fetch server-side.
"""
import asyncio
import json
import argparse
from aiohttp import web, ClientSession, CookieJar

RMNOISE_LOGIN    = 'https://rmnoise.com/users2/login'
RMNOISE_WEBRTC   = 'https://rmnoise.com/users2/get_webrtc_token'
RMNOISE_TURN     = 'https://rmnoise.com/users2/get_turn_credentials'

async def handle_credentials(request):
    try:
        body = await request.json()
        username = body.get('username', '').strip()
        password = body.get('password', '').strip()
        if not username or not password:
            return web.json_response({'ok': False, 'error': 'username and password required'}, status=400)
    except Exception:
        return web.json_response({'ok': False, 'error': 'invalid JSON body'}, status=400)

    jar = CookieJar(unsafe=True)
    async with ClientSession(cookie_jar=jar) as session:
        # Step 1 — login
        try:
            resp = await session.post(
                RMNOISE_LOGIN,
                data={'username': username, 'password': password, 'rememberme': ''},
                allow_redirects=False
            )
            if resp.status != 302:
                return web.json_response({'ok': False, 'error': 'Authentication failed'})
        except Exception as e:
            return web.json_response({'ok': False, 'error': f'Login error: {e}'})

        # Step 2 — WebRTC token
        try:
            resp = await session.post(RMNOISE_WEBRTC)
            webrtc_token = await resp.json()
        except Exception as e:
            return web.json_response({'ok': False, 'error': f'WebRTC token error: {e}'})

        # Step 3 — TURN credentials
        try:
            resp = await session.post(RMNOISE_TURN)
            turn_creds = await resp.json()
        except Exception as e:
            return web.json_response({'ok': False, 'error': f'TURN creds error: {e}'})

    return web.json_response({
        'ok': True,
        'webrtc_token': webrtc_token,
        'turn_creds':   turn_creds,
    })

async def handle_options(request):
    # Handle CORS preflight (not strictly needed for same-origin but harmless)
    return web.Response(status=204)

def main():
    parser = argparse.ArgumentParser(description='RMNoise credentials proxy')
    parser.add_argument('--port', type=int, default=9374)
    parser.add_argument('--host', default='0.0.0.0')
    args = parser.parse_args()

    app = web.Application()
    app.router.add_post('/api/rmnoise/credentials', handle_credentials)
    app.router.add_route('OPTIONS', '/api/rmnoise/credentials', handle_options)

    print(f'RMNoise proxy listening on {args.host}:{args.port}')
    web.run_app(app, host=args.host, port=args.port, access_log=None)

if __name__ == '__main__':
    main()
