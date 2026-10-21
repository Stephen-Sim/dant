BeforeAll {
    $installer = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../scripts/ci/install-pester.ps1'))
    function Invoke-IsolatedPesterInstall {
        param([string]$Directory)
        function Get-PSRepository {
            [CmdletBinding()]
            param()
            if ($PSBoundParameters['ErrorAction'] -ne 'Stop') { throw 'Repository query contract changed' }
            $global:dantPesterInstallFixture.Calls += 'query'
            if ($global:dantPesterInstallFixture.QueryFailure) { throw 'Synthetic repository query failed' }
            return $global:dantPesterInstallFixture.Repositories
        }
        function Register-PSRepository {
            [CmdletBinding()]
            param([switch]$Default)
            if (!$Default -or $PSBoundParameters['ErrorAction'] -ne 'Stop') { throw 'Default registration contract changed' }
            $global:dantPesterInstallFixture.Calls += 'register'
            if ($global:dantPesterInstallFixture.RegisterFailure) { throw 'Synthetic repository registration failed' }
            $global:dantPesterInstallFixture.Repositories = $global:dantPesterInstallFixture.RegisteredRepositories
        }
        function Save-Module {
            [CmdletBinding()]
            param($Name, $RequiredVersion, $Path, $Repository, [switch]$Force, [switch]$AcceptLicense)
            $global:dantPesterInstallFixture.Calls += 'save'
            $global:dantPesterInstallFixture.Save = @{
                Name = $Name; Version = $RequiredVersion; Path = $Path; Repository = $Repository
                Force = $Force.IsPresent; AcceptLicense = $AcceptLicense.IsPresent; ErrorAction = $PSBoundParameters['ErrorAction']
            }
            if (!$global:dantPesterInstallFixture.Repositories.Count) { throw "Synthetic Get-PackageSource: Unable to find repository 'PSGallery'" }
            if ($global:dantPesterInstallFixture.SaveFailure) { throw 'Synthetic module download failed' }
        }
        function Test-ModuleManifest {
            [CmdletBinding()]
            param($Path)
            $global:dantPesterInstallFixture.Calls += 'manifest'
            $global:dantPesterInstallFixture.ManifestPath = $Path
            if ($global:dantPesterInstallFixture.ManifestFailure) { throw 'Synthetic module manifest failed' }
            return $global:dantPesterInstallFixture.Manifest
        }
        function Set-PSRepository { throw 'A test must never change repository trust' }
        & $installer -ProjectRoot $Directory
    }
}

Describe 'Pinned Pester installation with isolated repository and download boundaries' {
    BeforeEach {
        $private = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $gallery = [pscustomobject]@{ Name = 'PSGallery'; SourceLocation = 'https://www.powershellgallery.com/api/v2'; InstallationPolicy = 'Untrusted' }
        $global:dantPesterInstallFixture = @{
            Repositories = @($gallery); RegisteredRepositories = @($gallery); Calls = @()
            QueryFailure = $false; RegisterFailure = $false; SaveFailure = $false; ManifestFailure = $false
            Manifest = [pscustomobject]@{ Name = 'Pester'; Version = [version]'5.9.0' }
        }
    }

    It 'registers only a missing default gallery then revalidates it before the exact pinned download' {
        $global:dantPesterInstallFixture.Repositories = @()
        Invoke-IsolatedPesterInstall $private
        $global:dantPesterInstallFixture.Calls | Should -Be @('query', 'register', 'query', 'save', 'manifest')
        $gallery.InstallationPolicy | Should -Be 'Untrusted'
        $global:dantPesterInstallFixture.Save.Version | Should -Be '5.9.0'
    }

    It 'keeps an existing official gallery untrusted and saves only the declared version and directory' {
        Invoke-IsolatedPesterInstall $private
        $global:dantPesterInstallFixture.Calls | Should -Be @('query', 'save', 'manifest')
        $saved = $global:dantPesterInstallFixture.Save
        $saved.Name | Should -Be 'Pester'
        $saved.Version | Should -Be '5.9.0'
        $saved.Path | Should -Be (Join-Path $private '.tools/powershell/Modules')
        $saved.Repository | Should -Be 'PSGallery'
        $saved.Force | Should -BeTrue
        $saved.AcceptLicense | Should -BeTrue
        $saved.ErrorAction | Should -Be 'Stop'
        $global:dantPesterInstallFixture.ManifestPath | Should -Be (Join-Path $private '.tools/powershell/Modules/Pester/5.9.0/Pester.psd1')
        $gallery.InstallationPolicy | Should -Be 'Untrusted'
    }

    It 'recognizes the official trailing slash without adding or trusting any repository' {
        $gallery.SourceLocation += '/'
        Invoke-IsolatedPesterInstall $private
        $global:dantPesterInstallFixture.Calls | Should -Be @('query', 'save', 'manifest')
    }

    It 'registers when unrelated repositories exist without modifying them' {
        $other = [pscustomobject]@{ Name = 'Fixture'; SourceLocation = 'https://example.invalid'; InstallationPolicy = 'Untrusted' }
        $global:dantPesterInstallFixture.Repositories = @($other)
        Invoke-IsolatedPesterInstall $private
        $global:dantPesterInstallFixture.Calls | Should -Be @('query', 'register', 'query', 'save', 'manifest')
        $other.SourceLocation | Should -Be 'https://example.invalid'
    }

    It 'rejects nonofficial duplicate missing or malformed gallery metadata before downloading' {
        foreach ($location in @('http://www.powershellgallery.com/api/v2', 'https://example.invalid/api/v2',
                'https://www.powershellgallery.com/api/v2?fixture=1', 'https://www.powershellgallery.com/api/v2#fragment',
                'https://user@www.powershellgallery.com/api/v2', 'https://www.powershellgallery.com:444/api/v2', '', $null)) {
            $global:dantPesterInstallFixture.Calls = @()
            $gallery.SourceLocation = $location
            { Invoke-IsolatedPesterInstall $private } | Should -Throw '*repository*'
            $global:dantPesterInstallFixture.Calls | Should -Be @('query')
        }
        $gallery.SourceLocation = 'https://www.powershellgallery.com/api/v2'
        $global:dantPesterInstallFixture.Repositories = @($gallery, $gallery)
        $global:dantPesterInstallFixture.Calls = @()
        { Invoke-IsolatedPesterInstall $private } | Should -Throw '*repository*'
        $global:dantPesterInstallFixture.Calls | Should -Be @('query')
    }

    It 'does not reinterpret a failed query or registration as a missing repository or success' {
        $global:dantPesterInstallFixture.QueryFailure = $true
        { Invoke-IsolatedPesterInstall $private } | Should -Throw '*query failed*'
        $global:dantPesterInstallFixture.Calls | Should -Be @('query')
        $global:dantPesterInstallFixture.QueryFailure = $false
        $global:dantPesterInstallFixture.Repositories = @()
        $global:dantPesterInstallFixture.RegisterFailure = $true
        $global:dantPesterInstallFixture.Calls = @()
        { Invoke-IsolatedPesterInstall $private } | Should -Throw '*registration failed*'
        $global:dantPesterInstallFixture.Calls | Should -Be @('query', 'register')
    }

    It 'refuses an unconfirmed registration and checks the registered source before Save-Module' {
        foreach ($registered in @(@(), @([pscustomobject]@{ Name = 'PSGallery'; SourceLocation = 'https://example.invalid' }))) {
            $global:dantPesterInstallFixture.Repositories = @()
            $global:dantPesterInstallFixture.RegisteredRepositories = $registered
            $global:dantPesterInstallFixture.Calls = @()
            { Invoke-IsolatedPesterInstall $private } | Should -Throw '*repository*'
            $global:dantPesterInstallFixture.Calls | Should -Be @('query', 'register', 'query')
        }
    }

    It 'propagates a failed download without retrying or validating a leftover manifest' {
        $global:dantPesterInstallFixture.SaveFailure = $true
        { Invoke-IsolatedPesterInstall $private } | Should -Throw '*download failed*'
        $global:dantPesterInstallFixture.Calls | Should -Be @('query', 'save')
    }

    It 'rejects missing invalid or wrong-version saved module metadata' {
        $global:dantPesterInstallFixture.ManifestFailure = $true
        { Invoke-IsolatedPesterInstall $private } | Should -Throw '*manifest failed*'
        $global:dantPesterInstallFixture.ManifestFailure = $false
        foreach ($manifest in @($null, [pscustomobject]@{ Name = 'Other'; Version = [version]'5.9.0' },
                [pscustomobject]@{ Name = 'Pester'; Version = [version]'5.8.0' })) {
            $global:dantPesterInstallFixture.Manifest = $manifest
            { Invoke-IsolatedPesterInstall $private } | Should -Throw '*manifest*'
        }
    }
}

AfterAll { Remove-Variable -Scope Global -Name dantPesterInstallFixture -ErrorAction SilentlyContinue }
