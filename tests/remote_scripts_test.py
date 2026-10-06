"""Run bundled POSIX scripts in a temporary tree with mocked service managers.

No SSH, package install, host service change or network access is performed.
Run: python tests/remote_scripts_test.py
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / 'src-tauri/src/scripts'
if os.name == 'nt':
    SHELL = str(Path(shutil.which('git')).resolve().parents[1] / 'bin/bash.exe')
else:
    SHELL = shutil.which('sh')


class RemoteScripts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for directory in ['etc/s-ui-hub', 'etc/init.d', 'etc/systemd/system', 'usr/local/lib/s-ui-hub', 'usr/bin', 'run', 'work']:
            (self.root / directory).mkdir(parents=True)
        self.config = self.root / 'etc/s-ui-hub/realm.json'
        binary = self.root / 'usr/local/lib/s-ui-hub/realm'
        binary.write_text('#!/bin/sh\nexit 0\n')
        binary.chmod(0o755)

    def run_script(self, name, init='systemd', extra='', stdin=''):
        root = self.root.as_posix()
        script = (SCRIPTS / name).read_text(encoding='utf-8')
        for prefix in ['/usr/local', '/usr/bin', '/etc', '/run']:
            script = script.replace(prefix, root + prefix)
        prelude = f'''set -eu
hub_tmp='{root}/work'
hub_init={init}
fail() {{ printf '%s\\n' "$1"; exit 1; }}
packages() {{ :; }}
sleep() {{ :; }}
fetch() {{ echo unexpected-download >&2; exit 97; }}
systemctl() {{ if [ "$1" = show ]; then echo 321; fi; }}
rc-update() {{ :; }}
service_stop() {{ rm -f '{root}/running'; }}
service_start() {{ touch '{root}/running'; }}
service_enable() {{ :; }}
service_running() {{ test -f '{root}/running'; }}
ss() {{ echo 'users:(("realm",pid=321,fd=8))'; }}
'''
        source = self.root / 'test.sh'
        source.write_text(prelude + extra + '\n' + script, encoding='utf-8', newline='\n')
        # Match SSH's literal LF bytes; text mode on Windows would send CRLF.
        result = subprocess.run([SHELL, str(source)], input=stdin.encode(), capture_output=True, timeout=15)
        result.stdout = result.stdout.decode()
        result.stderr = result.stderr.decode()
        return result

    def test_scripts_parse_as_posix_shell(self):
        for path in SCRIPTS.glob('*.sh'):
            result = subprocess.run([SHELL, '-n', str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_apply_and_disable_for_both_init_systems(self):
        for init in ['systemd', 'openrc']:
            with self.subTest(init=init):
                (self.root / 'run/s-ui-hub-realm.pid').write_text('321\n')
                result = self.run_script('apply-realm.sh', init, stdin='1\n12345\n{"endpoints":[{}]}\n')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('HUB_OK', result.stdout)
                self.assertTrue((self.root / 'running').exists())
                result = self.run_script('apply-realm.sh', init, stdin='0\n\n{"endpoints":[]}\n')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse((self.root / 'running').exists())
                self.assertEqual(self.config.read_text().strip(), '{"endpoints":[]}')

    def test_partial_bind_failure_restores_previous_config_and_running_service(self):
        self.config.write_text('previous-config')
        (self.root / 'running').touch()
        # A live process is insufficient: one of the listeners belongs to another pid.
        result = self.run_script('apply-realm.sh', extra='ss() { echo "pid=999,"; }', stdin='1\n12345\nnew-config\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('HUB_ROLLED_BACK', result.stdout)
        self.assertEqual(self.config.read_text(), 'previous-config')
        self.assertTrue((self.root / 'running').exists())

    def test_first_apply_failure_removes_failed_config(self):
        result = self.run_script('apply-realm.sh', extra='ss() { return 1; }', stdin='1\n12345\nnew-config\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('HUB_ROLLED_BACK', result.stdout)
        self.assertFalse(self.config.exists())
        self.assertFalse((self.root / 'running').exists())

    def test_realm_initialization_preserves_config_and_writes_native_service(self):
        self.config.write_text('existing-config')
        for init, service in [('systemd', 'etc/systemd/system/s-ui-hub-realm.service'), ('openrc', 'etc/init.d/s-ui-hub-realm')]:
            result = self.run_script('install-realm.sh', init, extra='uname() { echo x86_64; }')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('HUB_OK', result.stdout)
            self.assertTrue((self.root / service).exists())
            self.assertEqual(self.config.read_text(), 'existing-config')

    def test_sui_refuses_existing_installation(self):
        (self.root / 'usr/local/s-ui').mkdir()
        result = self.run_script('install-sui.sh', stdin='2095\n/app/\nadmin\nsecret\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('HUB_SUI_EXISTS', result.stdout)
        self.assertNotIn('secret', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
