#!/usr/bin/env python3
"""Start this machine's existing media services, then open ChocheyTV."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

URL = 'http://127.0.0.1:4800'
UNITS = ['mnt-media.mount', 'mullvad-daemon.service', 'snap.docker.dockerd.service',
         'docker-media.service', 'tvclone-prod.service', 'tvclone-organizer.service',
         'tvclone-backup.timer', 'tvclone-watchdog.timer']

def run(args, timeout=120):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)

def active(unit):
    return run(['systemctl', 'is-active', '--quiet', unit], 10).returncode == 0

def ready():
    try:
        with urllib.request.urlopen(URL + '/api/health', timeout=3) as response:
            return json.load(response).get('ready') is True
    except Exception:
        return False

def downloader_running():
    result = run(['docker', 'inspect', '--format', '{{.State.Running}}', 'qbittorrent'], 15)
    return result.returncode == 0 and result.stdout.strip() == 'true'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Check readiness without changing anything')
    parser.add_argument('--no-browser', action='store_true', help='Start services without opening a browser')
    args = parser.parse_args()
    if args.check:
        state = {'services': {u: active(u) for u in UNITS}, 'downloadsRunning': downloader_running(), 'serverReady': ready()}
        print(json.dumps(state, indent=2))
        return 0 if all(state['services'].values()) and state['downloadsRunning'] and state['serverReady'] else 1

    state_dir = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'chocheytv'
    state_dir.mkdir(parents=True, exist_ok=True)
    lock = (state_dir / 'startup.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 0
    log = (state_dir / 'startup.log').open('w')
    progress = None
    if not args.no_browser and shutil.which('zenity'):
        progress = subprocess.Popen(['zenity', '--progress', '--pulsate', '--auto-close', '--no-cancel',
            '--title=Starting ChocheyTV', '--text=Checking your media services…', '--width=420'],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
    def message(text):
        log.write(text + '\n'); log.flush()
        if progress and progress.poll() is None:
            try:
                progress.stdin.write('# ' + text + '\n'); progress.stdin.flush()
            except BrokenPipeError:
                pass
    def close_progress():
        if progress and progress.poll() is None:
            progress.terminate()
            try: progress.wait(timeout=5)
            except subprocess.TimeoutExpired: progress.kill()
    try:
        missing = [unit for unit in UNITS if not active(unit)]
        if missing:
            message('Starting the media drive and background services…')
            command = ['/usr/bin/systemctl', 'start', *missing]
            result = run(['sudo', '-n', *command])
            if result.returncode:
                message('Linux may ask for your password to start system services.')
                result = run(['pkexec', *command], timeout=300)
            if result.returncode:
                raise RuntimeError('Could not start services. ' + result.stderr.strip())
        message('Checking the download service…')
        if not downloader_running():
            result = run(['docker', 'start', 'qbittorrent'])
            if result.returncode:
                raise RuntimeError('Could not start qBittorrent. ' + result.stderr.strip())
        message('Waiting for ChocheyTV to be ready…')
        deadline = time.monotonic() + 90
        while not ready() and time.monotonic() < deadline:
            time.sleep(1)
        stopped = [unit for unit in UNITS if not active(unit)]
        if not ready() or stopped or not downloader_running():
            raise RuntimeError('Some services are not ready: ' + ', '.join(stopped or ['server or downloads']) + '. See ' + str(state_dir / 'startup.log'))
        message('ChocheyTV is ready.')
        close_progress()
        if not args.no_browser:
            subprocess.Popen(['xdg-open', URL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return 0
    except Exception as error:
        message(str(error)); close_progress()
        if not args.no_browser and shutil.which('zenity'):
            run(['zenity', '--error', '--title=ChocheyTV needs attention', '--text=' + str(error), '--width=460'], timeout=300)
        else:
            print(str(error))
        return 1
    finally:
        close_progress(); log.close(); lock.close()

if __name__ == '__main__':
    raise SystemExit(main())
