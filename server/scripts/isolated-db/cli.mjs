// Command line contract for the isolated suite runner (design section 7).
//
// Options: --list, --jobs N, --file <manifest test path> (repeatable),
// --report <path>. Positional manifest test paths stay accepted as the historical
// form; everything else is a configuration error (exit 2) and must be rejected
// before any child test loads. Node flags are never accepted here.

export const CLI_USAGE = 'usage: test-isolated-db.sh [--list] [--jobs N] [--file <test>]... [--report <path>] [<test>...]';

export const CLI_EXIT_CONFIGURATION = 2;

function configurationError(message) {
  return Object.assign(new Error(message), { exitCode: CLI_EXIT_CONFIGURATION });
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw configurationError(`${option} requires a value; ${CLI_USAGE}`);
  }
  return value;
}

function requireTestPath(value, option) {
  if (typeof value !== 'string' || value.startsWith('-') || !value.endsWith('.test.mjs')) {
    throw configurationError(`${option} accepts only a manifest .test.mjs path; ${CLI_USAGE}`);
  }
  return value;
}

/**
 * Parse runner arguments. Throws an Error carrying exitCode 2 for anything the
 * contract does not allow, so the caller never starts a child on bad input.
 */
export function parseRunnerArgs(argv) {
  const result = { list: false, jobs: 1, files: [], report: null };
  if (!Array.isArray(argv)) throw configurationError(`arguments must be an array; ${CLI_USAGE}`);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== 'string' || argument.length === 0) {
      throw configurationError(`empty argument; ${CLI_USAGE}`);
    }
    if (argument === '--list') {
      result.list = true;
      continue;
    }
    if (argument === '--jobs') {
      const value = requireValue(argv, index + 1, '--jobs');
      index += 1;
      if (!/^[1-9][0-9]*$/.test(value)) throw configurationError(`--jobs expects a positive integer; ${CLI_USAGE}`);
      const jobs = Number(value);
      if (!Number.isSafeInteger(jobs) || jobs > 8) throw configurationError(`--jobs must be between 1 and 8; ${CLI_USAGE}`);
      result.jobs = jobs;
      continue;
    }
    if (argument === '--file') {
      const value = requireValue(argv, index + 1, '--file');
      index += 1;
      result.files.push(requireTestPath(value, '--file'));
      continue;
    }
    if (argument === '--report') {
      if (result.report !== null) throw configurationError(`--report may be given only once; ${CLI_USAGE}`);
      const value = requireValue(argv, index + 1, '--report');
      index += 1;
      result.report = value;
      continue;
    }
    if (argument.startsWith('-')) {
      throw configurationError(`unknown option ${argument}; ${CLI_USAGE}`);
    }
    result.files.push(requireTestPath(argument, 'positional argument'));
  }
  if (result.list && (result.files.length > 0 || result.report !== null)) {
    throw configurationError(`--list runs alone; ${CLI_USAGE}`);
  }
  return result;
}

/**
 * Map a thrown error to the documented exit contract: 2 configuration, 3 safety
 * invariant, 4 internal orchestrator failure, 1 everything else (assertions,
 * setup fixtures, timeouts, cleanup and leak failures).
 */
export function exitCodeForError(error) {
  if (!error || typeof error !== 'object') return 1;
  if (Number.isInteger(error.exitCode)) return error.exitCode;
  if (error.code === 'ESAFETY') return 3;
  if (error.code === 'CLOSED_ERROR') return 4;
  return 1;
}
