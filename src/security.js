import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function isWithin(root, target) {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  if (samePath(rootResolved, targetResolved)) return true;
  const relativePath = relative(rootResolved, targetResolved);
  return relativePath !== '' && !relativePath.startsWith('..' + sep) && relativePath !== '..' && !isAbsolute(relativePath);
}

async function realRoots(config) {
  return Promise.all(config.allowedRoots.map(async (root) => {
    try {
      return await realpath(root);
    } catch {
      return resolve(root);
    }
  }));
}

async function existingAncestor(path) {
  let current = resolve(path);
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function allowedByRoots(roots, target) {
  return roots.some((root) => isWithin(root, target));
}

export async function assertAllowedFile(inputPath, config, options = {}) {
  if (typeof inputPath !== 'string' || !isAbsolute(inputPath)) {
    throw new Error(`video_path must be an absolute local path. Received: ${String(inputPath)}`);
  }
  const candidate = resolve(inputPath);
  const roots = await realRoots(config);
  let resolvedPath;
  try {
    resolvedPath = await realpath(candidate);
  } catch {
    throw new Error(`File does not exist: ${candidate}`);
  }
  if (!allowedByRoots(roots, resolvedPath)) {
    throw new Error(`Access denied: the file is outside HIGHLIGHT_ALLOWED_ROOTS (${roots.join(', ')}).`);
  }
  const info = await stat(resolvedPath);
  if (!info.isFile()) throw new Error(`Expected a regular file: ${resolvedPath}`);
  if (info.size > config.maxVideoBytes) {
    throw new Error(`File is larger than the configured limit (${config.maxVideoBytes} bytes): ${resolvedPath}`);
  }
  if (options.extensions?.length) {
    const lower = resolvedPath.toLowerCase();
    if (!options.extensions.some((extension) => lower.endsWith(extension.toLowerCase()))) {
      throw new Error(`Unsupported media extension. Expected one of: ${options.extensions.join(', ')}`);
    }
  }
  return { path: resolvedPath, info };
}

export async function assertAllowedDirectory(inputPath, config, options = {}) {
  if (typeof inputPath !== 'string' || !isAbsolute(inputPath)) {
    throw new Error(`output_dir must be an absolute local path. Received: ${String(inputPath)}`);
  }
  const candidate = resolve(inputPath);
  const roots = await realRoots(config);
  if (!allowedByRoots(roots, candidate)) {
    throw new Error(`Access denied: output_dir is outside HIGHLIGHT_ALLOWED_ROOTS (${roots.join(', ')}).`);
  }
  if (options.create) {
    // Validate the nearest existing parent before mkdir so a symlink cannot
    // redirect creation outside the allowlist.
    const parent = await existingAncestor(candidate);
    if (!allowedByRoots(roots, parent)) throw new Error('output_dir has a symlinked parent outside the allowlist');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(candidate, { recursive: true });
  }
  try {
    const actual = await realpath(candidate);
    if (!allowedByRoots(roots, actual)) throw new Error('resolved output directory escapes the allowlist');
    const info = await stat(actual);
    if (!info.isDirectory()) throw new Error(`Not a directory: ${actual}`);
    return actual;
  } catch (error) {
    if (options.create) throw error;
    throw new Error(`Output directory does not exist: ${candidate}`);
  }
}

export function assertSafeChildName(name, label = 'name') {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(name)) {
    throw new Error(`${label} may contain only letters, numbers, dot, underscore, and hyphen.`);
  }
  return name;
}
