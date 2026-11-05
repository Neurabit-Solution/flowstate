/**
 * npm and friends are .cmd files on Windows, which only run through the shell, and the shell
 * joins arguments without quoting them. Quotes each one so spaces and quotes survive.
 */
export function windowsCommandLine(command: string[]): string {
  return command
    .map((arg) => {
      if (/^[\w:.\\/=-]+$/.test(arg)) return arg;
      // Backslashes before a quote must be doubled, and the quote itself escaped.
      return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
    })
    .join(' ');
}
