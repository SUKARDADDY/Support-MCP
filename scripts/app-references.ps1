# Dot-sourced by build-app.ps1 and test-app-native.ps1. Returns the csc arguments
# that compile against the .NET Framework 4.5.2 reference assemblies in
# $ReferenceDir and nothing else: /noconfig and /nostdlib+ stop the compiler from
# adding the newer framework installed on this PC, so it cannot bind to a method
# that 4.5.2 lacks.
function Get-AppCompilerReferences([string]$ReferenceDir) {
    $names = 'mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll', 'PresentationFramework.dll', 'PresentationCore.dll', 'WindowsBase.dll', 'System.Xaml.dll'
    $flags = @('/noconfig', '/nostdlib+')
    foreach ($name in $names) {
        $file = Join-Path $ReferenceDir $name
        if (-not (Test-Path -LiteralPath $file)) { throw "Missing $name in $ReferenceDir. Run scripts\fetch-net452-refs.ps1 and pass its output folder." }
        $flags += "/reference:$file"
    }
    return $flags
}
