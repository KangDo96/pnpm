import runLifecycleHooks from '@pnpm/lifecycle'
import logger from '@pnpm/logger'
import { PackageJson } from '@pnpm/types'
import { realNodeModulesDir } from '@pnpm/utils'
import pLimit = require('p-limit')
import { PackageNode } from 'pkgs-graph'
import RecursiveSummary from './recursiveSummary'

export default async (
  packageChunks: string[][],
  graph: {[id: string]: PackageNode},
  args: string[],
  cmd: string,
  opts: {
    bail: boolean,
    workspaceConcurrency: number,
    unsafePerm: boolean,
    rawNpmConfig: object,
  },
) => {
  const scriptName = args[0]
  let hasCommand = 0

  const result = {
    fails: [],
    passes: 0,
  } as RecursiveSummary

  const limitRun = pLimit(opts.workspaceConcurrency)
  const stdio = (
    opts.workspaceConcurrency === 1 ||
    packageChunks.length === 1 && packageChunks[0].length === 1
  ) ? 'inherit' : 'pipe'

  for (const chunk of packageChunks) {
    await Promise.all(chunk.map((prefix: string) =>
      limitRun(async () => {
        const pkg = graph[prefix] as {manifest: PackageJson, path: string}
        if (!pkg.manifest.scripts || !pkg.manifest.scripts[scriptName]) {
          return
        }
        hasCommand++
        try {
          const lifecycleOpts = {
            depPath: prefix,
            pkgRoot: prefix,
            rawNpmConfig: opts.rawNpmConfig,
            rootNodeModulesDir: await realNodeModulesDir(prefix),
            stdio,
            unsafePerm: opts.unsafePerm || false,
          }
          if (pkg.manifest.scripts[`pre${scriptName}`]) {
            await runLifecycleHooks(`pre${scriptName}`, pkg.manifest, lifecycleOpts)
          }
          await runLifecycleHooks(scriptName, pkg.manifest, lifecycleOpts)
          if (pkg.manifest.scripts[`post${scriptName}`]) {
            await runLifecycleHooks(`post${scriptName}`, pkg.manifest, lifecycleOpts)
          }
          result.passes++
        } catch (err) {
          logger.info(err)

          if (!opts.bail) {
            result.fails.push({
              error: err,
              message: err.message,
              prefix,
            })
            return
          }

          // tslint:disable:no-string-literal
          err['code'] = 'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL'
          err['prefix'] = prefix
          // tslint:enable:no-string-literal
          throw err
        }
      },
    )))
  }

  if (scriptName !== 'test' && !hasCommand) {
    const err = new Error(`None of the packages has a "${scriptName}" script`)
    err['code'] = 'RECURSIVE_RUN_NO_SCRIPT' // tslint:disable-line:no-string-literal
    throw err
  }

  return result
}
