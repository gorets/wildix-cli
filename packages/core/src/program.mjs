// The program that runs on this core: its command name, npm package and version. The command line of each package
// calls setProgram() once, before it runs, so the messages of the core name the right command ("Log in with:
// wx-admin login <e-mail>") and requests carry its user agent. Read at the time of use, never captured at load.
export const program = {
  name: 'wx', // the command people type
  pkg: 'wldx-cli', // the npm package (npx <pkg>, the user agent)
  version: '0.0.0',
};

export function setProgram({name, pkg, version}) {
  if (!name || !pkg || !version) throw new Error('setProgram needs name, pkg and version');
  Object.assign(program, {name, pkg, version});
}

export const userAgent = () => `${program.pkg}/${program.version}`;
export const loginHint = () => `Log in with: ${program.name} login <e-mail>`;
