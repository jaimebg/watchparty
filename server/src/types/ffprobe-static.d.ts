// ffprobe-static ships no type declarations. It's a plain CJS module doing
// `exports.path = <binaryPath>`, so the default import (Node's native ESM
// interop for CJS) resolves to the whole `{ path: string }` object.
declare module 'ffprobe-static' {
  const ffprobeStatic: { path: string }
  export default ffprobeStatic
}
