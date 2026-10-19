# Windows VM setup and troubleshooting

English · [Chinese](zh-CN/VM.md)

dant's desktop, task engine, data, and Codex run inside an Ubuntu VM. The Windows Controller reaches the VM's work API at `127.0.0.1:4317` through an SSH local tunnel. The VM Node service starts Codex over stdio; the desktop bridge is also accessible only inside the VM. New VMs default to 4 CPUs, 6 GB RAM, and a 40 GB disk. Hyper-V uses its Default Switch; VMware Workstation uses NAT. The Worker boundary and SSH connection are the same for both.

On a fresh installation, first choose whether you have an existing dant backup. A portable backup can be imported before a VM is available. Otherwise the guide explains how to create a work computer, detect Hyper-V/VMware, or connect an existing SSH computer. Creation requires your explicit action; merely viewing the guide does not create a VM. Existing configured installations open normally. After connecting a new VM, preview and restore an imported backup to continue with its memory and projects; see [backups](backups.md).

## Worker deployment and operation

The first connection deploys an explicit source allowlist, verifies and installs Node 22 in the VM user's directory, installs runtime dependencies from the lockfile, and creates the ordinary user's `dant-worker.service` and `dant-guest-local.service`. With user lingering enabled, closing the Windows Controller does not stop these services. The legacy system desktop bridge on port 4319 remains available; the new Worker uses the local lease-aware bridge on port 4320. Neither listens on an external VM address.

The Worker refuses to execute tasks on Windows, bare-metal Linux, as root, or without a working graphical desktop. Updates check for active work and calls first. An active executor is preserved and its update is deferred; an unchanged source version reuses the existing healthy services.

Legacy Windows chat migration saves a complete backup first, then imports attachments into the VM's UUID storage. Migration refuses to overwrite a target that already holds another conversation. Codex maintains and refreshes its own authentication; deployment neither reads nor packages its authentication files.

```powershell
# Deploy using the selected data directory's existing vm.json, without a Windows UI.
node src/server.mts --deploy-worker

# Show setup preparation only; do not automatically connect the Worker.
node src/server.mts --prepare
```

Authoritative VM data is in `~/dant/data/`, conversation workspaces are in `~/dant/workspaces/<conversationId>/`, and deployed application versions are in `~/dant/releases/`. Inspect user services with `systemctl --user status dant-worker dant-guest-local` and `journalctl --user -u dant-worker`. Do not commit raw logs containing private conversations.

## Choose a creation provider

Settings → **Create work computer** offers Automatic, Hyper-V, and VMware Workstation. Detection is read only. Automatic retains the configured provider, otherwise selects available Hyper-V before VMware. A selected provider failure is reported without falling back to another provider. Hyper-V creation requests Windows administrator authorization; VMware reuses installed Workstation tools without Hyper-V elevation. Neither flow changes a valid existing connection to create a different VM.

See [VMware setup](vmware.md) for that provider’s commands, storage layout and recovery. The detailed image preparation below applies to Hyper-V. To connect a computer you already own, use the SSH path instead.

## Connect an existing work computer

Existing Ubuntu VMs can run on VMware, Hyper-V, or another hypervisor. Import/manual connection uses SSH and does not create a VM or convert its disks. The guest must provide SSH key access, Python 3, a working graphical desktop, and an ordinary user accepted by the VM runtime checks. Installing the Worker does not turn a server-only guest into a graphical desktop.

The installed app and desktop launcher use `%APPDATA%\com.dant.desktop\data` by default. An explicit `DANT_DATA` selects a different directory. Earlier development runs commonly kept connection details in the project's `data` directory. Different local data directories do not mean that the VM needs to be recreated.

The Controller checks only known local sources: the selected data directory, the known project's `data` directory, explicit `DANT_VM_PROFILE_DIR` or JSON-array `DANT_VM_PROFILE_DIRS` directories, and directories previously registered by this user's Controller. It does not recursively search disks. An existing valid `vm.json` takes precedence. A single different valid source can be imported automatically; multiple sources require an explicit choice in settings. You can also enter the absolute directory containing the old `vm.json`. Duplicate profiles with the same SSH endpoint, user, and canonical private-key path count as one source.

On Windows, the user registry is `%LOCALAPPDATA%\dant\vm-profiles.json`. It records profile-directory paths and is scoped to the current account; it does not store private-key contents.

Import writes only connection fields. Relative private-key and `known_hosts` paths are resolved against the original profile directory. It does not copy private-key contents, chat history, server state, or another account's data. Keep the original directory containing the key. Any newly generated AppData key and previous setup-failure record remain untouched. The UI connects after an explicit import succeeds; the import API itself does not start a connection or recreate the VM.

`GET /api/vm/profiles` returns the current profile and candidates. `POST /api/vm/import` accepts `{id}` or `{directory}` and refuses to replace an existing valid connection. A missing binding or key produces instructions to import the original directory or choose its existing key instead of a raw `ENOENT` error.

A historical `failed:*` setup status does not block automatic connection to a valid existing VM. An actively preparing, creating, installing, or administrator-approval operation postpones automatic connection; old failure logs remain available. If the selected provider reports that a VM with the same name already exists, recover its original connection profile first. Do not regenerate its seed or recreate it merely because a new local data directory lacks `vm.json`.

## Hyper-V initial setup

Requires Windows with Hyper-V enabled, the OpenSSH client, Python 3, and network access to the Ubuntu and npm repositories. The image archive is approximately 810 MiB; its extracted fixed VHD is approximately 30 GiB. Conversion needs additional space for the dynamic VHDX. Image preparation can run in ordinary PowerShell. Windows requires administrator authorization to create/start a Hyper-V VM, and the app's setup flow may show a UAC prompt.

From the project directory:

```powershell
.\scripts\prepare-vm.ps1
# Requires administrator PowerShell, or the app's VM setup flow.
.\scripts\create-vm.ps1
.\scripts\check-vm.ps1
```

For an installed app, pass the same absolute `-DataDirectory` to all three scripts:

```powershell
$dantData = Join-Path $env:APPDATA 'com.dant.desktop\data'
.\scripts\prepare-vm.ps1 -DataDirectory $dantData
.\scripts\create-vm.ps1 -DataDirectory $dantData
.\scripts\check-vm.ps1 -DataDirectory $dantData
```

A custom data directory contains `cache/vm`, `tools/python`, `vm`, `logs`, SSH keys, and `vm.json`. Without this argument, the scripts retain the project's `data`, `.cache/vm`, and `.tools/python` layout. `vm-key` is a private key: do not upload it, commit it, or paste it into logs. The seed script reads only the public key to build the ISO.

`prepare-vm.ps1` downloads the official Ubuntu 24.04 Azure VHD archive, verifies SHA-256, and creates an ed25519 SSH key and NoCloud ISO. The ordinary `dant` user has no sudo permission or password login by default, and root SSH login is disabled. If the VM agent explicitly needs sudo, pass `-AdminSudo` during initial preparation; this changes the agent's permissions inside the VM.

The seed's stable, path-safe `instance-id` uses the first 20 hexadecimal characters of the public key's SHA-256 digest. A raw public-key base64 substring is unsuitable because it can contain `/`.

`scripts/vm-key.py` invokes OpenSSH with a Python argument array to avoid PowerShell 5/7 differences when passing an empty passphrase. Preparation prints only generation, validation, or repair results. An existing unencrypted key is checked against its public key. Automatic legacy passphrase removal is restricted to a file named `vm-key` that can be decrypted with the old script's two-double-quote passphrase, whose private and public comments are both `dant-local-vm`, and whose public keys match. The key pair and comments remain unchanged. Other encrypted keys, foreign comments, and mismatched public keys are rejected without modifying the files.

`create-vm.ps1` uses the existing Default Switch and verifies that the source disk is neither mounted nor registered to another VM. It prepares NoCloud, converts and enlarges a dynamic VHDX, registers a generation-1 Hyper-V VM, attaches the ISO, and starts it. After obtaining an IP address, it saves `vm.json`. Software installation can still be running at that point; use `check-vm.ps1` to establish readiness.

Windows `tar` can extract the official source image as an NTFS sparse file, causing Hyper-V conversion error `0xC03A001A`. After NoCloud preparation and before conversion, the script runs `fsutil sparse setflag <sourceVHD> 0` only on the verified unused, unmounted official source VHD. This allocates its holes as ordinary disk space; it does not change compression/encryption settings on host directories. A sparse source requires twice its logical size plus 1 GiB of free space, approximately 61 GiB for the current image. A non-sparse source requires its logical size plus 1 GiB. The script then verifies length, attributes, VHD/filesystem configuration, and remaining space. Compressed or encrypted source/target locations produce an explicit error; choose a suitable data directory.

Inside the VM, `dant-bootstrap.service` installs XFCE, Xvfb, screenshot/input tools, fonts, Firefox, and Codex CLI. Downloads retry, and systemd retries a failed bootstrap. It writes `/home/dant/work/.dant-ready` only after the X display is accessible, all three desktop services are healthy, an actual screenshot returns PNG, and Codex is executable. The readiness check exits 0 on success and 1 when not ready.

## Why the Azure image needs offline preparation

The current official image's `/etc/cloud/cloud.cfg.d/90_dpkg.cfg` specifies `datasource_list: [ Azure ]`. This prevents first boot from selecting the NoCloud CD. Putting a NoCloud setting in the CD's user-data cannot change datasource discovery early enough.

Before creating the VM, `scripts/patch-image.py` makes one equal-length replacement in that ordinary configuration file on the unmounted source fixed VHD:

```text
datasource_list: [ Azure ]
datasource_list: [NoCloud]
```

The tool validates the fixed VHD footer/checksum, protective MBR, GPT header/table CRCs, unique Linux partition, ext4 block/inode/descriptor layout, directory path, extent bounds, and full original file content. It rejects unknown layouts or configurations immediately. It neither mounts the disk nor changes file length/filesystem metadata, and it does not modify existing VHDX files. Before writing, it records original/replacement bytes, physical offset, and footer fingerprint in `cache/vm/image-patch-audit.json`, then flushes and rereads the result. Repeated runs require a matching original audit record.

This method targets the current official Azure GPT/ext4 layout. A future image layout may be rejected. Inspect that image first; do not bypass validation or perform an unrestricted disk-wide replacement.

Read-only inspection:

```powershell
python .\scripts\patch-image.py .\data\vm\livecd.ubuntu-cpc.azure.vhd
```

References: [cloud-init datasource configuration](https://docs.cloud-init.io/en/latest/reference/datasources.html), [NoCloud](https://docs.cloud-init.io/en/24.2/reference/datasources/nocloud.html), [Microsoft's Azure image datasource guidance](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/create-upload-ubuntu), and [Windows allocation when clearing a sparse flag](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/6a884fe5-3da1-4abb-84c4-f419d349d878).

## Progress and logs

On Windows, `data/vm-setup-status.json` records the stage, last update, log path, and error; installed apps use the selected data directory instead. Hyper-V `data/logs/create-vm-*.log` contains the administrator script's full transcript; VMware uses `data/vmware/logs/`. The setup record includes the provider. Common Hyper-V stages:

| Stage                               | Meaning                                               |
| ----------------------------------- | ----------------------------------------------------- |
| `extracting-image`                  | Extract the source VHD                                |
| `configuring-nocloud`               | Validate and prepare first-boot configuration         |
| `allocating-source-disk`            | Clear the source sparse flag and allocate its holes   |
| `converting-disk` / `resizing-disk` | Create and enlarge the dynamic disk                   |
| `registering-vm` / `booting-vm`     | Register and start the Hyper-V VM                     |
| `waiting-for-ip`                    | Wait for Hyper-V integration services to report IPv4  |
| `guest-installing`                  | SSH connection saved; VM software is still installing |
| `ready`                             | Actual readiness checks passed                        |
| `failed:<stage>`                    | Inspect the error field and referenced log            |

Inspect guest installation:

```powershell
.\scripts\check-vm.ps1 -Diagnostics
```

This prints cloud-init status, desktop/bootstrap service status, bootstrap journal output, and the tail of `/var/log/dant-bootstrap.log`. The default `dant` user belongs to `adm` and can read those installation logs.

## Recover after interruption

- **VM with the same name already exists:** the creation script stops and preserves it by default. Recover an existing connection profile first. If you have confirmed that the VM uses this data directory's `vm/dant.vhdx`, `create-vm.ps1 -Resume` can start it or continue waiting for its IP and refresh `vm.json`. It does not replace the disk or reinitialize the guest.
- **IP timeout or a network change:** check the VM and Default Switch in Hyper-V Manager. Use `-Resume` to refresh the address, then restart dant to reread the connection.
- **Only the source `.vhd` exists, without a `.vhdx` or registered VM:** inspect the previous failure log before rerunning creation. The source is revalidated; its audit identifies an already completed patch.
- **A `.vhdx` exists but no VM was registered:** overwrite is refused. Review whether conversion/expansion completed and whether another VM uses the disk; a maintainer must decide how to resume registration. Do not delete the disk to bypass the error.
- **Temporary network failure:** bootstrap retries automatically. Inspect `-Diagnostics`, wait for connectivity, then check again.
- **SSH works but readiness fails:** inspect `dant-bootstrap.service` and its logs. Initial desktop installation takes time; SSH alone does not prove that screenshots or Codex work.
- **SSH cannot connect:** confirm the address and VM state, Windows OpenSSH on `PATH`, and the existing private-key path. If the host key changed, verify the destination and retain the `known_hosts` evidence while investigating.
- **The public key matches but SSH reports `Permission denied (publickey)`:** check whether the Windows private key unexpectedly has a passphrase. An early script's PowerShell 7 `-N '""'` handling could set two literal double quotes as the passphrase, preventing `BatchMode=yes` signing. Preparation verifies and narrowly repairs confirmed legacy project keys. Replacing the seed ISO cannot decrypt the Windows private key. Repair preserves the original key pair and does not require rebuilding the VM.

Changing the chat model or application mode does not change Windows Hyper-V/UAC authorization. For administrator-launch failures, use the setup log and the specific Windows error.

## Local verification

```powershell
python -m unittest discover -s tests/vm -p test_vm.py -v
python -m py_compile scripts/seed.py scripts/patch-image.py scripts/vm-key.py vm/desktop.py vm/guest.py
```

Tests use a synthetic VHD to verify equal-length-only changes, an immutable audit, and rejection of corrupt/unknown images. They verify mouse-button release after interrupted dragging, reread the seed ISO to check its path-safe instance ID and null sudo setting, and generate temporary test keys to cover empty passphrases, confirmed legacy repair, and rejection of unknown encryption, foreign comments, or mismatched public keys. These checks do not replace real VM first boot, network installation, and desktop validation.
