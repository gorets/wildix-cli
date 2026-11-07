// Shell completion. `<program> completion <shell>` prints a small script; on every Tab it runs
// `<program> __complete -- <words after the program, the last one being the word under the cursor>`, which prints
// the candidates, one per line as "value<TAB>description". The candidates come from the command definitions (the
// saved profiles for --profile, the completers of the spec for other kinds), so completion follows the commands
// without a regenerated script. No network.
import {sessions} from './auth.mjs';
import {program} from './program.mjs';
import {COMMON_OPTIONS, commandOf, globalsOf, groupOf, isGroup, singleOf} from './registry.mjs';

export const SHELLS = ['bash', 'zsh', 'fish'];

export const TOP_LEVEL = {
  completion: 'print the shell completion script (bash, zsh, fish)',
};

// The options offered before a command: help, version and the global options that take a value.
const topOptions = (globals) => [
  ['--help', `help of ${program.name}`],
  ['--version', `the version of ${program.name}`],
  ...Object.entries(globals)
    .filter(([, o]) => o.type === 'string')
    .map(([name, o]) => [`--${name}`, o.description]),
];

function valuesOf(option, env, spec) {
  if (option.choices) return option.choices.map((v) => [v]);
  if (option.complete === 'profiles') return sessions(env).map((s) => [s.email]);
  const completer =
    option.complete && spec.completers && Object.hasOwn(spec.completers, option.complete)
      ? spec.completers[option.complete]
      : undefined;
  return completer ? completer(env) : [];
}

// The candidates for the word under the cursor: ["value\tdescription", ...].
export function complete(words, env, spec) {
  const globals = globalsOf(spec);
  const cur = words.length ? words[words.length - 1] : '';
  const offer = (pairs) => pairs.filter(([v]) => v.startsWith(cur)).map(([v, d]) => (d ? `${v}\t${d}` : v));
  // The global options may stand anywhere: the value of one is offered, and they are left out of what names the
  // command (wx --profile a@b.c chat <Tab> completes like wx chat <Tab>).
  const globalOf = (word) => {
    const name = word?.startsWith('--') ? word.slice(2).split('=')[0] : undefined;
    return name && Object.hasOwn(globals, name) ? name : undefined;
  };
  const before = words.slice(0, -1);
  const last = before[before.length - 1];
  if (globalOf(last) && !last.includes('=') && globals[globalOf(last)].type === 'string') {
    return offer(valuesOf(globals[globalOf(last)], env, spec));
  }
  const done = [];
  for (let i = 0; i < before.length; i += 1) {
    const name = globalOf(before[i]);
    if (name) {
      if (globals[name].type === 'string' && !before[i].includes('=')) i += 1;
      continue;
    }
    done.push(before[i]);
  }

  if (done.length === 0) {
    return offer([
      ...Object.entries(spec.groups).map(([name, g]) => [name, g.summary]),
      ...Object.entries(spec.commands).map(([name, c]) => [name, c.summary]),
      ...Object.entries(TOP_LEVEL),
      ...(cur.startsWith('-') ? topOptions(globals) : []),
    ]);
  }
  if (done[0] === 'completion') return done.length === 1 ? offer(SHELLS.map((s) => [s, `the script for ${s}`])) : [];

  // The command and how many words name it: 1 for a single command, 2 for a group and its command.
  let cmd = singleOf(done[0], spec);
  let depth = 1;
  if (!cmd) {
    const group = groupOf(done[0], spec);
    if (!group) return [];
    if (done.length === 1) return offer(Object.entries(group.commands).map(([name, c]) => [name, c.summary]));
    cmd = commandOf(group, done[1]);
    depth = 2;
    if (isGroup(cmd)) {
      if (done.length === 2) return offer(Object.entries(cmd.commands).map(([name, c]) => [name, c.summary]));
      cmd = commandOf(cmd, done[2]);
      depth = 3;
    }
  }
  if (!cmd) return [];
  const options = {...cmd.options, ...COMMON_OPTIONS, ...globals};
  const prev = done[done.length - 1];
  if (done.length > depth && prev.startsWith('--')) {
    const option = Object.hasOwn(options, prev.slice(2)) ? options[prev.slice(2)] : undefined;
    if (option?.type === 'string') return offer(valuesOf(option, env, spec));
  }
  if (cur.startsWith('-')) {
    const used = new Set(
      done
        .slice(depth)
        .filter((w) => w.startsWith('--'))
        .map((w) => w.slice(2)),
    );
    return offer(
      Object.entries(options)
        .filter(([name, o]) => o.multiple || !used.has(name))
        .map(([name, o]) => [`--${name}`, o.description]),
    );
  }
  // A command whose argument has values to offer (wx profile use <Tab>, wx-admin pbx use <Tab>).
  if (cmd.complete) return offer(valuesOf({complete: cmd.complete}, env, spec));
  return [];
}

// The scripts call the installed program by its name; the shell functions are named after it (wx-admin: _wx_admin).
function scripts() {
  const n = program.name;
  const fn = `_${n.replace(/[^A-Za-z0-9]/g, '_')}`;
  return {
    bash: `# ${n} completion for bash. Add to ~/.bashrc:  eval "$(${n} completion bash)"
${fn}_complete() {
  # The words are taken as an array first: bash 3.2 (macOS) joins the elements of a quoted array slice when IFS
  # is a newline.
  local words=("\${COMP_WORDS[@]:1:COMP_CWORD}") out line
  COMPREPLY=()
  out=$(${n} __complete -- "\${words[@]}" 2>/dev/null) || return 0
  # Line by line from a here-string: no word splitting and no glob expansion of the candidates.
  while IFS= read -r line; do
    [[ -n $line ]] && COMPREPLY+=("\${line%%$'\\t'*}")
  done <<< "$out"
}
complete -F ${fn}_complete ${n}
`,
    zsh: `# ${n} completion for zsh. Add to ~/.zshrc (after compinit):  eval "$(${n} completion zsh)"
${fn}() {
  local -a lines items
  local line
  lines=("\${(@f)$(${n} __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  for line in $lines; do
    [[ -n $line ]] || continue
    if [[ $line == *$'\\t'* ]]; then items+=("\${\${line%%$'\\t'*}//:/\\\\:}:\${line#*$'\\t'}")
    else items+=("\${line//:/\\\\:}"); fi
  done
  (( \${#items} )) && _describe -t ${n}-candidates '${n}' items
}
(( \${+functions[compdef]} )) || { autoload -Uz compinit && compinit; }
compdef ${fn} ${n}
`,
    fish: `# ${n} completion for fish. Save as ~/.config/fish/completions/${n}.fish:  ${n} completion fish > ~/.config/fish/completions/${n}.fish
complete -c ${n} -f -a '(${n} __complete -- (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)'
`,
  };
}

export function completionScript(shell) {
  const all = scripts();
  return Object.hasOwn(all, shell) ? all[shell] : undefined;
}

export function completionUsage() {
  const n = program.name;
  return [
    `Usage: ${n} completion [bash|zsh|fish]   (default: the shell of $SHELL)`,
    '',
    'Prints the completion script. To turn completion on for good:',
    `  bash:  echo 'eval "$(${n} completion bash)"' >> ~/.bashrc`,
    `  zsh:   echo 'eval "$(${n} completion zsh)"' >> ~/.zshrc`,
    `  fish:  ${n} completion fish > ~/.config/fish/completions/${n}.fish`,
    `then open a new terminal. It completes an installed \`${n}\` (npm i -g ${program.pkg}), not \`npx ${program.pkg}\`.`,
  ].join('\n');
}
