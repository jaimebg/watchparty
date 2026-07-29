import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Los tests no deben heredar el config.defaults.json versionado en el repo:
// apuntamos a una ruta inexistente para partir siempre de los valores de fábrica.
process.env.JBG_DEFAULTS_FILE = join(tmpdir(), 'jbg-tests-sin-defaults.json')
