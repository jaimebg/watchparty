import { execFile } from 'node:child_process'

// Opens the NATIVE folder picker on the host's machine (server and host are the
// same machine; the browser cannot expose absolute filesystem paths). Returns the
// chosen path, or null if the user cancels or no dialog is available.
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
