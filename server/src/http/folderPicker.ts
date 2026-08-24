import { execFile } from 'node:child_process'

// Abre el selector de carpetas NATIVO en la máquina del host (servidor y host son la
// misma máquina; el navegador no puede exponer rutas absolutas del filesystem).
// Devuelve la ruta elegida, o null si el usuario cancela o no hay diálogo disponible.
export function pickFolderNative(): Promise<string | null> {
  const run = (bin: string, args: string[]) =>
    new Promise<string | null>(resolve =>
      execFile(bin, args, { timeout: 300_000 }, (err, stdout) =>
        resolve(err ? null : stdout.trim() || null)))

  if (process.platform === 'darwin') {
    return run('osascript', ['-e', 'POSIX path of (choose folder with prompt "Pick your media folder")'])
  }
  if (process.platform === 'win32') {
    return run('powershell', ['-NoProfile', '-STA', '-Command',
      "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Pick your media folder'; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }"])
  }
  return run('zenity', ['--file-selection', '--directory', '--title=Pick your media folder'])
}
