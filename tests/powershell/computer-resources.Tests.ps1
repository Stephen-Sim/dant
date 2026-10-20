BeforeAll {
    $repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $repositoryRoot 'scripts/computer/resource-config.ps1')
    $canonicalText = [IO.File]::ReadAllText((Join-Path $repositoryRoot 'resources/config/computer.json'))
}

Describe 'Shared VM resource contracts before any provisioning side effect' {
    BeforeEach {
        $file = Join-Path $TestDrive ([guid]::NewGuid().ToString('N') + '.json')
        [IO.File]::WriteAllText($file, $canonicalText, [Text.UTF8Encoding]::new($false))
    }

    It 'uses canonical defaults and preserves explicit boundary values without reading environment defaults' {
        $value = Get-DantComputerResources
        foreach ($name in @('cpu', 'memoryGB', 'diskGB')) {
            $bounds = $value.$name
            (Resolve-DantComputerResource $bounds $null $false) | Should -Be $bounds.default
            (Resolve-DantComputerResource $bounds $bounds.min $true) | Should -Be $bounds.min
            (Resolve-DantComputerResource $bounds $bounds.max $true) | Should -Be $bounds.max
            foreach ($invalid in @($null, $true, '4', 1.5, ($bounds.min - 1), ($bounds.max + 1))) {
                { Resolve-DantComputerResource $bounds $invalid $true } | Should -Throw '*Invalid VM resource setting*'
            }
        }
    }

    It 'accepts mathematical integer spellings and fixed-point ranges' {
        foreach ($number in @('12.0', '12e0', '2147483647')) {
            [IO.File]::WriteAllText($file, ('{"cpu":{"default":N,"min":N,"max":N},"memoryGB":{"default":N,"min":N,"max":N},"diskGB":{"default":N,"min":N,"max":N}}'.Replace('N', $number)))
            $value = Get-DantComputerResources $file
            $value.cpu.default | Should -Be ([double]$number)
            (Resolve-DantComputerResource $value.cpu $null $false) | Should -Be ([double]$number)
        }
    }

    It 'rejects unknown fields, invalid numbers, duplicate keys and malformed JSON' {
        $suffix = ',"memoryGB":{"default":8,"min":2,"max":128},"diskGB":{"default":64,"min":32,"max":2048}}'
        $invalidValues = @('null', '[]', '{}', '{"unexpected":0}', '{', ($canonicalText + '{}'),
            ('{"cpu":{},"cpu":{}' + $suffix))
        foreach ($value in @('null', '[]', '{}', '{"unexpected":0,"default":4,"min":1,"max":64}',
            '{"default":4,"min":5,"max":64}', '{"default":4,"min":1,"max":3}')) {
            $invalidValues += '{"cpu":' + $value + $suffix
        }
        foreach ($value in @('false', 'null', '"4"', '1.5', '0', '2147483648', '9007199254740992', '[]', '{"unexpected":4}')) {
            $invalidValues += '{"cpu":{"default":' + $value + ',"min":1,"max":64}' + $suffix
        }
        foreach ($invalid in $invalidValues) {
            [IO.File]::WriteAllText($file, $invalid)
            { Get-DantComputerResources $file } | Should -Throw
        }
    }

    It 'rejects missing, directory, oversized, linked and invalid UTF8 files' {
        { Get-DantComputerResources ($file + '.missing') } | Should -Throw
        { Get-DantComputerResources $TestDrive } | Should -Throw
        [IO.File]::WriteAllBytes($file, [byte[]]::new(4097))
        { Get-DantComputerResources $file } | Should -Throw
        [IO.File]::WriteAllBytes($file, [byte[]]@(255))
        { Get-DantComputerResources $file } | Should -Throw
        [IO.File]::WriteAllText($file, ([string][char]0xfeff + $canonicalText))
        { Get-DantComputerResources $file } | Should -Throw
        [IO.File]::WriteAllText($file, $canonicalText)
        $link = $file + '.link'
        New-Item -ItemType HardLink -Path $link -Target $file | Out-Null
        { Get-DantComputerResources $file } | Should -Throw
        [IO.File]::ReadAllText($file) | Should -Be $canonicalText
    }
}
