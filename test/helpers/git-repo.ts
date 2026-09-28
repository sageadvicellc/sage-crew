import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeFixtureHome } from './env.ts';

/** A throwaway git repository inside the run's temp home. */
export interface FixtureRepo {
  root: string;
  write: (path: string, text: string) => void;
  git: (...args: string[]) => string;
  commit: (message: string) => void;
}

export function makeFixtureRepo(): FixtureRepo {
  const root = makeFixtureHome();
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'init.defaultBranch=main',
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    );
  git('init', '-q');
  return {
    root,
    git,
    write(path, text) {
      const abs = join(root, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    },
    commit(message) {
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', message);
    },
  };
}
