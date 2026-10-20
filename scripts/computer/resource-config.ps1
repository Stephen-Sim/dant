# This module reads only the fixed, packaged resource contract. Loading it does
# not inspect a VM, launch a process, or read configuration from the environment.
function Get-DantComputerResources {
    param([string]$Path = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'resources/config/computer.json'))

    $maximumBytes = 4096
    $maximumResourceValue = 2147483647
    $invalid = 'Invalid computer resource configuration'
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw $invalid }
    $attributes = [IO.File]::GetAttributes($Path)
    if ($attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory)) { throw $invalid }

    if (!('DantComputerResourceFile' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DantComputerResourceFile {
    [StructLayout(LayoutKind.Sequential)]
    private struct Information {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Modified;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Information info);
    public static string Identity(SafeFileHandle handle) {
        Information info;
        if (!GetFileInformationByHandle(handle, out info) || info.Links != 1 || (info.Attributes & 0x410) != 0)
            throw new IOException("Invalid computer resource file");
        return String.Join(":", info.Volume, info.IndexHigh, info.IndexLow, info.Created.dwHighDateTime,
            info.Created.dwLowDateTime, info.SizeHigh, info.SizeLow,
            info.Modified.dwHighDateTime, info.Modified.dwLowDateTime);
    }
}
'@ -ErrorAction Stop
    }

    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $identity = [DantComputerResourceFile]::Identity($stream.SafeFileHandle)
        if ($stream.Length -gt $maximumBytes) { throw $invalid }
        $bytes = [byte[]]::new([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if (!$count) { throw $invalid }
            $offset += $count
        }
        if ([DantComputerResourceFile]::Identity($stream.SafeFileHandle) -cne $identity) { throw $invalid }
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        if ($text.StartsWith([string][char]0xfeff, [StringComparison]::Ordinal)) { throw $invalid }
        $value = ConvertFrom-Json -InputObject $text -ErrorAction Stop

        # Retain object-key identity before ConvertFrom-Json could overwrite a
        # duplicate. JSON syntax has already been checked by the parser above.
        $tokens = [regex]::Matches($text, '"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]')
        $stack = [Collections.Generic.List[object]]::new()
        for ($index = 0; $index -lt $tokens.Count; $index++) {
            $token = $tokens[$index].Value
            if ($token -ceq '{') {
                $stack.Add([Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal))
            } elseif ($token -ceq '[') {
                $stack.Add($null)
            } elseif ($token -ceq '}' -or $token -ceq ']') {
                $stack.RemoveAt($stack.Count - 1)
            } elseif ($token.StartsWith('"') -and $index + 1 -lt $tokens.Count -and $tokens[$index + 1].Value -ceq ':') {
                $key = ConvertFrom-Json -InputObject $token
                $current = $stack[$stack.Count - 1]
                if ($null -eq $current -or !$current.Add($key)) { throw $invalid }
            }
        }

        $keys = @('cpu', 'memoryGB', 'diskGB')
        if ($value -isnot [pscustomobject] -or @($value.PSObject.Properties).Count -ne $keys.Count) { throw $invalid }
        foreach ($property in $value.PSObject.Properties) {
            if ($keys -cnotcontains $property.Name) { throw $invalid }
            $bounds = $property.Value
            if ($bounds -isnot [pscustomobject] -or @($bounds.PSObject.Properties).Count -ne 3) { throw $invalid }
            foreach ($bound in $bounds.PSObject.Properties) {
                if (@('default', 'min', 'max') -cnotcontains $bound.Name) { throw $invalid }
                $number = $bound.Value
                if ($number -is [bool] -or $null -eq $number -or $number -is [string] -or
                    $number -isnot [ValueType] -or [double]::IsNaN([double]$number) -or
                    $number -lt 1 -or $number -gt $maximumResourceValue -or [math]::Truncate([double]$number) -ne $number) { throw $invalid }
            }
            if ($bounds.min -gt $bounds.default -or $bounds.default -gt $bounds.max) { throw $invalid }
        }
        if ([DantComputerResourceFile]::Identity($stream.SafeFileHandle) -cne $identity -or
            ([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint)) { throw $invalid }
        $current = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            if ([DantComputerResourceFile]::Identity($current.SafeFileHandle) -cne $identity) { throw $invalid }
        } finally {
            $current.Dispose()
        }
        return $value
    } catch {
        throw $invalid
    } finally {
        $stream.Dispose()
    }
}

function Resolve-DantComputerResource {
    param([Parameter(Mandatory=$true)]$Range, $Value, [bool]$Provided)
    if (!$Provided) { $Value = $Range.default }
    if ($null -eq $Value -or $Value -is [bool] -or $Value -is [string] -or
        $Value -isnot [ValueType] -or $Value -lt $Range.min -or $Value -gt $Range.max -or
        [math]::Truncate([double]$Value) -ne $Value) { throw 'Invalid VM resource setting' }
    return [int]$Value
}
