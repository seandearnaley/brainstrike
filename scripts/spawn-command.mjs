const WINDOWS_SHELL_META_RE = /[\s"&|<>^()%!]/;

export function quoteWindowsShellArg(arg) {
  if (arg.length === 0) {
    return '""';
  }

  if (!WINDOWS_SHELL_META_RE.test(arg)) {
    return arg;
  }

  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1');
  return `"${escaped}"`;
}

export function createSpawnInvocation(command, args, platform = process.platform) {
  if (platform !== 'win32') {
    return { args, command, shell: false };
  }

  // Windows package-manager shims require a shell; call sites pass trusted script args.
  // This quoting preserves argv boundaries, but is not a sanitizer for untrusted cmd.exe input.
  return {
    args: [],
    command: [command, ...args].map(quoteWindowsShellArg).join(' '),
    shell: true,
  };
}
