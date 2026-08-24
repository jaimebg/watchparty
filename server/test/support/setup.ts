import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The tests must not inherit the config.defaults.json versioned in the repo: we
// point at a non-existent path so they always start from the factory values.
process.env.JBG_DEFAULTS_FILE = join(tmpdir(), 'jbg-tests-no-defaults.json')
