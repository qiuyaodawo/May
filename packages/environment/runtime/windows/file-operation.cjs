const fs = require('node:fs');
const path = require('node:path');

const [operation, root, inputPath, rawOptions] = process.argv.slice(2);
const options = JSON.parse(rawOptions);
const rootPath = path.resolve(root);

function inside(value) {
  const relative = path.relative(rootPath, value);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function resolveTarget(value) {
  const absolute = path.resolve(rootPath, value);
  if (!inside(absolute)) throw failure('ENVIRONMENT_INVALID_PATH', 'path is outside the workspace');
  let pending = path.relative(rootPath, absolute).split(path.sep).filter(Boolean);
  let current = rootPath;
  let links = 0;
  while (pending.length !== 0) {
    current = path.join(current, pending.shift());
    let info;
    try { info = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return path.join(current, ...pending);
    }
    if (info.isSymbolicLink()) {
      if (++links > 40) throw failure('ENVIRONMENT_INVALID_PATH', 'too many symbolic links');
      const destination = path.resolve(path.dirname(current), fs.readlinkSync(current));
      if (!inside(destination)) throw failure('ENVIRONMENT_INVALID_PATH', 'path resolves outside the workspace');
      pending = [...path.relative(rootPath, destination).split(path.sep).filter(Boolean), ...pending];
      current = rootPath;
    }
  }
  return current;
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function metadata(target) {
  const info = fs.statSync(target);
  return {
    absolutePath: target,
    linkCount: info.nlink,
    type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
    size: info.size,
    modifiedAtSeconds: info.mtimeMs / 1000,
  };
}

function list(target, recursive) {
  const entries = [];
  const pending = [target];
  while (pending.length !== 0) {
    for (const item of fs.readdirSync(pending.pop(), { withFileTypes: true })) {
      const candidate = path.join(item.parentPath, item.name);
      // 链接作为目录项报告；递归查询不会进入链接目标。
      const info = fs.lstatSync(candidate);
      const link = info.isSymbolicLink();
      const entry = {
        name: item.name,
        path: path.relative(rootPath, candidate).split(path.sep).join('/'),
        type: link ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
        size: info.size,
        modifiedAtSeconds: info.mtimeMs / 1000,
        ...(link ? { linkTarget: fs.readlinkSync(candidate) } : {}),
      };
      entries.push(entry);
      if (entries.length >= options.maxEntries) return { entries, truncated: true };
      if (recursive && info.isDirectory() && !link) pending.push(resolveTarget(candidate));
    }
  }
  return { entries, truncated: false };
}

function execute() {
  const target = resolveTarget(inputPath);
  switch (operation) {
    case 'stat': return { metadata: metadata(target) };
    case 'read': {
      const info = metadata(target);
      if (info.type !== 'file') throw failure('ENVIRONMENT_PATH_NOT_A_FILE', 'path must be a regular file');
      if (info.size > options.maxBytes) throw failure('ENVIRONMENT_OUTPUT_TOO_LARGE', 'file exceeds its byte limit');
      const contents = fs.readFileSync(target);
      if (contents.length > options.maxBytes) throw failure('ENVIRONMENT_OUTPUT_TOO_LARGE', 'file exceeds its byte limit');
      process.stdout.write(contents);
      return { metadata: info };
    }
    case 'write': {
      if (options.CreateParents !== 'false') fs.mkdirSync(path.dirname(target), { recursive: true });
      const contents = fs.readFileSync(0);
      if (contents.length > options.maxBytes) throw failure('ENVIRONMENT_OUTPUT_TOO_LARGE', 'file exceeds its byte limit');
      if (fs.existsSync(target) && fs.statSync(target).nlink > 1) throw failure('ENVIRONMENT_PATH_UNSUPPORTED', 'writing a hard-linked file is not supported');
      const temporary = path.join(path.dirname(target), `.may-write-${require('node:crypto').randomUUID()}`);
      try {
        fs.writeFileSync(temporary, contents, { flag: 'wx' });
        if (options.Overwrite === 'false') fs.copyFileSync(temporary, target, fs.constants.COPYFILE_EXCL);
        else fs.renameSync(temporary, target);
      } finally { fs.rmSync(temporary, { force: true }); }
      return { metadata: metadata(target) };
    }
    case 'list': return list(target, options.Recursive === 'true');
    case 'mkdir': {
      fs.mkdirSync(target, { recursive: options.Recursive === 'true' });
      return { metadata: metadata(target) };
    }
    case 'remove-file': fs.unlinkSync(target); return {};
    case 'remove-directory': {
      if (options.Recursive === 'true') fs.rmSync(target, { recursive: true });
      else fs.rmdirSync(target);
      return {};
    }
    default: throw failure('ENVIRONMENT_INVALID_OPTION', `unknown operation: ${operation}`);
  }
}

try {
  process.stderr.write(`${JSON.stringify({ ok: true, ...execute() })}\n`);
} catch (error) {
  const codes = {
    ENOENT: 'ENVIRONMENT_PATH_NOT_FOUND', ENOTDIR: 'ENVIRONMENT_PATH_NOT_FOUND',
    EACCES: 'ENVIRONMENT_PATH_FORBIDDEN', EPERM: 'ENVIRONMENT_PATH_FORBIDDEN',
    EEXIST: 'ENVIRONMENT_PATH_EXISTS', EISDIR: 'ENVIRONMENT_PATH_NOT_A_FILE',
  };
  process.stderr.write(`${JSON.stringify({ ok: false, code: codes[error.code] ?? error.code ?? 'ENVIRONMENT_OPERATION_FAILED', message: error.message })}\n`);
  process.exitCode = 1;
}
