import { execFile } from 'node:child_process'
import { serverMessage, type Lang } from '../i18n.js'

// Opens the NATIVE folder picker on the host's machine (server and host are the
// same machine; the browser cannot expose absolute filesystem paths). Returns the
// chosen path, or null if the user cancels or no dialog is available.
export function pickFolderNative(lang: Lang = 'en'): Promise<string | null> {
  const prompt = serverMessage(lang, 'prompt.pickFolder')
  const run = (bin: string, args: string[]) =>
    new Promise<string | null>(resolve =>
      execFile(bin, args, { timeout: 300_000 }, (err, stdout) =>
        resolve(err ? null : stdout.trim() || null)))

  if (process.platform === 'darwin') {
    const escaped = prompt.replace(/"/g, '\\"')
    return run('osascript', ['-e', `POSIX path of (choose folder with prompt "${escaped}")`])
  }
  if (process.platform === 'win32') {
    const escaped = prompt.replace(/'/g, "''")
    return run('powershell', ['-NoProfile', '-STA', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '${escaped}'; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }`])
  }
  return run('zenity', ['--file-selection', '--directory', `--title=${prompt}`])
}
