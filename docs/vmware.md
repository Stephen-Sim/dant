# VMware Workstation

English · [Chinese](zh-CN/vmware.md)

dant can create its Ubuntu work computer with an existing Windows VMware Workstation installation. This is separate from connecting an already installed Ubuntu VM through SSH: importing an existing connection never creates a disk, converts a VM, or changes its hypervisor.

## Requirements and selection

The automatic VMware flow requires Workstation's `vmrun.exe` and `vmware-vdiskmanager.exe`, Python 3, Windows OpenSSH, and access to the Ubuntu and package repositories. dant reuses these tools; it does not install Workstation, qemu, or another virtualization product. It does not request Hyper-V administrator authorization. Guest sudo permission remains a separate, explicit choice for a newly created computer.

New VMs use VMware NAT. Both Windows services **VMnetDHCP** and **VMware NAT Service** must be running. Preparation checks their status before downloading an image or generating a key/seed; initial creation checks again before converting a disk. This check only reads service status. If either service is stopped, missing, or cannot be checked, open Windows Services (`services.msc`) and ask the computer administrator to start or repair the VMware services before retrying. dant does not change host services, virtual networks, Hyper-V, or VBS. Connecting an existing SSH computer and resuming an owned VM do not use this creation-only service gate.

To inspect the services without changing them:

```powershell
Get-Service -Name 'VMnetDHCP','VMware NAT Service' | Select-Object Name,Status,StartType
```

In Settings, choose **Create work computer → VMware Workstation**. Automatic preserves the configured provider; without one, it prefers available Hyper-V before VMware. Explicit VMware failures are reported instead of silently switching to Hyper-V. An existing valid computer connection is preserved.

## Script equivalent

From the checkout, run ordinary PowerShell:

```powershell
$dantData = Join-Path $env:APPDATA 'com.dant.desktop\data'
.\scripts\prepare-vmware.ps1 -DataDirectory $dantData
.\scripts\create-vmware.ps1 -DataDirectory $dantData -Cpu 4 -MemoryGB 8 -DiskGB 64
.\scripts\check-vm.ps1 -DataDirectory $dantData
```

Use the same absolute data directory throughout. Optional `-VmrunPath` and `-VdiskmanagerPath` on preparation select explicit existing tool paths. Add `-AdminSudo` to preparation only if you want the new guest's dant account to administer its system. Existing seed/disk files are not rewritten to change that permission.

Preparation downloads the official Ubuntu 24.04 AMD64 VMDK, verifies it against the official SHA-256 manifest, prepares an SSH key and NoCloud seed, and installs the ISO helper in a private tools directory. Creation builds a managed VMX and disk, starts the guest using Workstation, waits for its address through VMware Tools, and writes the top-level SSH binding. The guest image includes open-vm-tools. A usable SSH address is not a successful installation check: wait for the graphical desktop, screenshot bridge and executor readiness check.

New VMs default to four CPUs, 8 GiB RAM and a 64 GiB disk. `-Resume` preserves an existing VM's resources, including larger custom sizes; it never converts or resizes its disk. `create-vmware.ps1` accepts `-IPTimeoutSeconds` for address discovery. The Worker and desktop services use the same VM-owned data boundary as Hyper-V; see [VM operation](VM.md).

## Files, progress and recovery

Provider-specific files live under `<data>/vmware/`: `cache/`, `tools/`, `vm-key`, `dant.vmx`, `dant.vmdk`, `manifest.json`, and `logs/`. Top-level `vm.json` selects the active connection, and `vm-setup-status.json` reports provider, stage and errors. The key is private; do not upload it or include it in bug reports.

Progress includes `checking-vmware`, `checking-vmware-network`, `downloading-image`, `verifying-image`, `preparing-seed`, `prepared`, `converting-image`, `expanding-disk`, `starting-vm`, `waiting-for-ip`, `guest-installing`, and failure stages. Read the recorded error and provider log if creation stops.

For an interrupted managed VM, use:

```powershell
.\scripts\create-vmware.ps1 -DataDirectory $dantData -Resume
```

Resume validates the manifest, critical VMX configuration, disk identity/capacity, and seed/public-key hashes before starting this managed VM or refreshing its IP/binding. It does not recreate its disk, seed, or administration settings. A partial building disk is preserved and rejected for manual inspection. Never delete it merely to bypass the check. For a VM created outside dant, use **Use existing computer** and its SSH details instead.

## Verification boundary

Tool detection and deterministic tests cover provider selection, read-only NAT service checks, file validation, refusal to overwrite existing state, and recovery behavior.

On 2026-10-17, an isolated Windows Workstation 17.0.2 test verified the official image checksum, disk conversion/expansion, seed preparation, and real guest boot using the corrected e1000 adapter. The initial stopped-DHCP problem was resolved through normal Windows RunAs administrator authorization to start VMnetDHCP. After a soft reboot, both DHCP and NAT services were running, SSH succeeded as `dant@192.168.163.138`, `systemd-detect-virt` returned `vmware`, and `df` reported a grown 38G root filesystem. Resume saved the isolated test profile’s top-level `provider: vmware`/`vmwareId` binding and reached `guest-installing`.

Installation subsequently completed, and `check-vm.ps1` passed SSH, XFCE, screenshot service and Codex CLI 0.163.0 readiness. The normal Controller connected with both service and Worker online. A real 1440 × 900 screenshot, leased keyboard input, lease release, and rejection of stale input passed. This fresh VMware VM has no ChatGPT sign-in; model replies and voice were not tested on it. The installed app’s original Hyper-V binding remained unchanged. Consult the [verification record](verification.md) for the latest acceptance results. Silent subscription voice checks also do not establish microphone or speaker operation.
