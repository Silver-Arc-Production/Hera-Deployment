/**
 * Discovers command files and collects their definitions.
 *
 * Commands live in ``hera/commands/<category>/<name>.ts``, one command per file.
 * Each file default-exports (or named-exports) one :class:`CommandDefinition`.
 * The loader walks the category folders, so adding a command means adding a file
 * -- nothing else needs editing.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { CommandDefinition } from './types';

export interface LoadedCommands {
  commands: CommandDefinition[];
  /** Files that failed to load, as ``[path, error]`` pairs. */
  failures: [string, Error][];
}

function isCommandFile(path: string): boolean {
  return ['.ts', '.js', '.mjs', '.cjs'].includes(extname(path));
}

/**
 * Recursively require a directory and pull command definitions out of each
 * module. A module may export a single ``command``/default, or a ``commands``
 * array.
 */
export function loadCommands(root: string): LoadedCommands {
  const commands: CommandDefinition[] = [];
  const failures: [string, Error][] = [];

  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!isCommandFile(path)) continue;
      // Skip declaration files produced by the compiler.
      if (path.endsWith('.d.ts')) continue;

      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const loaded = require(path) as Record<string, unknown>;
        const defaultExport = loaded.command ?? loaded.default;
        const multiple = loaded.commands;
        if (Array.isArray(multiple)) {
          for (const item of multiple) commands.push(item as CommandDefinition);
        } else if (defaultExport && typeof defaultExport === 'object') {
          commands.push(defaultExport as CommandDefinition);
        }
      } catch (error) {
        failures.push([path, error as Error]);
      }
    }
  };

  walk(root);
  return { commands, failures };
}
