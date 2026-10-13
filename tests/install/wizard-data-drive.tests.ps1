param(
    [Parameter(Mandatory=$true)][string]$TestExe,
    [Parameter(Mandatory=$true)][string]$PackageDir,
    [Parameter(Mandatory=$true)][string]$FixtureRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# CI only: never change the runner workspace drive's owner or permissions.
# Use a real disposable NTFS volume, not a SUBST alias of an ordinary directory.
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This disposable-disk fixture is for GitHub Actions only.' }
$fixture = [IO.Path]::GetFullPath($FixtureRoot)
if (-not (Test-Path -LiteralPath $fixture -PathType Container)) { throw 'Existing private fixture folder required.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'The CI disk fixture needs an elevated runner.' }
$usedDrives = [Environment]::GetLogicalDrives()
$driveLetter = @('R','S','T','U','V','W','X','Y','Z') | Where-Object { ($_ + ':\') -notin $usedDrives } | Select-Object -First 1
if (-not $driveLetter) { throw 'No free drive letter for the isolated fixture.' }
$id = [guid]::NewGuid().ToString('N')
$diskPath = Join-Path $fixture ("wizard-$id.vhdx")
$createScript = Join-Path $fixture ("wizard-$id.diskpart.txt")
if ((Test-Path -LiteralPath $diskPath) -or (Test-Path -LiteralPath $createScript)) { throw 'Fixture files already exist.' }
try {
    @("create vdisk file=`"$diskPath`" maximum=256 type=expandable", "attach vdisk", "exit") | Set-Content -LiteralPath $createScript -Encoding ascii
    & (Join-Path $env:WINDIR 'System32\diskpart.exe') /s $createScript
    if ($LASTEXITCODE -ne 0) { throw 'Creating the isolated VHD failed.' }
    # Resolve the disk from our unique image, never from a guessed disk number.
    $image = Get-DiskImage -ImagePath $diskPath
    if (-not $image.Attached) { throw 'The fixture VHD did not attach.' }
    $disk = $image | Get-Disk
    if ($disk.IsBoot -or $disk.IsSystem -or $disk.Size -gt 300MB -or $disk.PartitionStyle -ne 'RAW') { throw 'Unexpected fixture disk identity.' }
    if ($disk.IsOffline) { $disk | Set-Disk -IsOffline $false }
    if ($disk.IsReadOnly) { $disk | Set-Disk -IsReadOnly $false }
    $partition = $disk | Initialize-Disk -PartitionStyle MBR -PassThru | New-Partition -UseMaximumSize -DriveLetter $driveLetter
    $label = 'ABTest-' + $id.Substring(0,8)
    $partition | Format-Volume -FileSystem NTFS -NewFileSystemLabel $label -Confirm:$false | Out-Null
    $mountedPartition = Get-Partition -DriveLetter $driveLetter
    $volume = $mountedPartition | Get-Volume
    if ($mountedPartition.DiskNumber -ne $disk.Number -or $volume.FileSystemLabel -ne $label) { throw 'Fixture drive does not map to the created image.' }
    $dataDrive = $driveLetter + ':\'
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($identity.User)
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($sid in @($identity.User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    }
    # Reproduce a data-volume root's self-DELETE grant, without child deletion.
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-11'),[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $dataDrive -AclObject $acl
    & $TestExe (Join-Path $fixture 'wizard') $PackageDir $dataDrive
    if ($LASTEXITCODE -ne 0) { throw 'Setup wizard regression failed.' }
} finally {
    if (Test-Path -LiteralPath $diskPath) {
        $image = Get-DiskImage -ImagePath $diskPath
        if ($image.Attached) { Dismount-DiskImage -ImagePath $diskPath | Out-Null }
        Remove-Item -LiteralPath $diskPath
    }
    if (Test-Path -LiteralPath $createScript) { Remove-Item -LiteralPath $createScript }
}
