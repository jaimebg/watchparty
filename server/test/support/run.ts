import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const pExecFile = promisify(execFile)

export async function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return pExecFile(bin, args, { maxBuffer: 64 * 1024 * 1024 })
}
