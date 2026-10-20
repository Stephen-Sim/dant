import argparse
import hashlib
import importlib.util
import io
import json
import pathlib

import pycdlib

resource_spec = importlib.util.spec_from_file_location(
    'dant_seed_resources', pathlib.Path(__file__).resolve().parent / 'computer/resource-config.py')
resource_config = importlib.util.module_from_spec(resource_spec)
resource_spec.loader.exec_module(resource_config)
resources = resource_config.read_resources()

parser = argparse.ArgumentParser(description='Create a dant NoCloud seed ISO')
parser.add_argument('root', type=pathlib.Path)
parser.add_argument('admin_sudo', choices=['true', 'false'])
parser.add_argument('--data-directory', type=pathlib.Path)
parser.add_argument('--cache-directory', type=pathlib.Path)
parser.add_argument('--provider', choices=['hyperv', 'vmware'], default='hyperv')
args = parser.parse_args()

root = args.root
network_module_path = pathlib.Path(__file__).resolve().parents[1] / 'vm/network_config.py'
network_spec = importlib.util.spec_from_file_location('dant_seed_network', network_module_path)
network_config = importlib.util.module_from_spec(network_spec)
network_spec.loader.exec_module(network_config)
protocol = network_config.read_protocol(root / network_config.PROTOCOL_RESOURCE)

admin = args.admin_sudo == 'true'
data = args.data_directory or root / 'data'
cache = args.cache_directory or root / '.cache/vm'
data.mkdir(parents=True, exist_ok=True)
cache.mkdir(parents=True, exist_ok=True)
public = (data / 'vm-key.pub').read_text().strip()
if not public.startswith('ssh-ed25519 '):
    raise ValueError('Expected the generated ed25519 public key')
units={
'dant-bootstrap.service':'''[Unit]
Description=Install and verify the dant guest environment
After=network-online.target
Wants=network-online.target
ConditionPathExists=!/home/dant/work/.dant-ready
StartLimitIntervalSec=0
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/dant/bootstrap.sh
RemainAfterExit=yes
Restart=on-failure
RestartSec=45
TimeoutStartSec=45min
[Install]
WantedBy=multi-user.target
''',
'dant-display.service':'''[Unit]
Description=dant virtual display
After=network.target
[Service]
User=dant
ExecStart=/usr/bin/Xvfb :0 -screen 0 1440x900x24 -ac -nolisten tcp
Restart=always
[Install]
WantedBy=multi-user.target
''',
'dant-desktop.service':'''[Unit]
Description=dant desktop session
After=dant-display.service
Requires=dant-display.service
[Service]
User=dant
Environment=DISPLAY=:0
Environment=HOME=/home/dant
ExecStartPre=/bin/sleep 3
ExecStart=/usr/bin/dbus-run-session -- /usr/bin/startxfce4
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
''',
'dant-guest.service':f'''[Unit]
Description=dant guest desktop bridge
After=dant-display.service dant-desktop.service
Requires=dant-display.service
[Service]
User=dant
Environment=DISPLAY=:0
Environment=HOME=/home/dant
Environment=DANT_GUEST_HOST={protocol['loopbackHost']}
Environment=DANT_GUEST_PORT={protocol['bootstrapGuestPort']}
WorkingDirectory=/opt/dant
ExecStart=/usr/bin/python3 /opt/dant/guest.py
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
'''}
files = [
    {'path': '/opt/dant/' + name, 'permissions': '0755',
     'content': (root / 'vm' / name).read_text(encoding='utf-8')}
    for name in ('desktop.py', 'desktop_mcp.py', 'voice_message.py', 'guest.py',
                 'control.py', 'network_config.py', 'start-codex.sh', 'bootstrap.sh')
]
files += [{'path': '/opt/dant/' + network_config.PROTOCOL_RESOURCE.as_posix(), 'permissions': '0644',
           'content': json.dumps(protocol, ensure_ascii=False, indent=2) + '\n'}]
files += [{'path': '/etc/systemd/system/' + name, 'content': text} for name, text in units.items()]
files += [{'path': '/etc/cloud/cloud.cfg.d/99-dant-datasource.cfg',
           'content': 'datasource_list: [ NoCloud, None ]\n'}]
user = {
    'name': 'dant',
    'shell': '/bin/bash',
    'groups': ['adm'],
    'lock_passwd': True,
    'ssh_authorized_keys': [public],
    'sudo': 'ALL=(ALL) NOPASSWD:ALL' if admin else None,
}
config = {
    'hostname': 'dant',
    'manage_etc_hosts': True,
    'users': [user],
    'ssh_pwauth': False,
    'disable_root': True,
    'write_files': files,
    'runcmd': [
        ['systemctl', 'daemon-reload'],
        ['systemctl', 'enable', '--now', '--no-block', 'dant-bootstrap.service'],
    ],
}
# JSON is valid YAML and avoids escaping errors in embedded shell/Python.
user_data = ('#cloud-config\n' + json.dumps(config, ensure_ascii=False, indent=2)).encode()
# cloud-init uses instance-id in filesystem paths and cache names. Raw public
# key base64 may contain '/', so derive a stable path-safe identifier instead.
meta = json.dumps({
    'instance-id': 'dant-' + hashlib.sha256(public.encode()).hexdigest()[:20],
    'local-hostname': 'dant',
}).encode()
network = json.dumps({'version': 2, 'ethernets': {'dant': {'match': {'name': 'e*'}, 'dhcp4': True}}}).encode()

iso = pycdlib.PyCdlib()
iso.new(interchange_level=3, joliet=3, vol_ident='cidata', rock_ridge='1.09')
for name, content, iso_name in (
    ('user-data', user_data, 'USERDATA.;1'),
    ('meta-data', meta, 'METADATA.;1'),
    ('network-config', network, 'NETWORK.;1'),
):
    iso.add_fp(io.BytesIO(content), len(content), iso_path='/' + iso_name,
               rr_name=name, joliet_path='/' + name)
iso.write(str(cache / 'seed.iso'))
iso.close()

summary = {
    'adminSudo': admin,
    'resourceDefaults': {name: value['default'] for name, value in resources.items()},
    'sshPasswordLogin': False,
    'desktop': 'XFCE / Xvfb 1440x900',
    'provider': args.provider,
    'image': 'Ubuntu 24.04 amd64 VMware VMDK' if args.provider == 'vmware' else 'Ubuntu 24.04 amd64 Azure VHD',
}
(cache / 'seed-summary.json').write_text(json.dumps(summary, indent=2))
print('Created cloud-init seed. VM sudo:', admin)
