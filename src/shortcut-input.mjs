// Inline Pi input component; unlike the clipboard dialog this does not own or parse terminal replies.
export function createShortcutInput({ tui, theme, keybindings, done, Input, truncateToWidth, isKeyRepeat,
  action, signal, suggest, validate }) {
  const input = new Input({ placeholder: 'e.g. ctrl+shift+v or f8', placeholderStyle: (text) => theme.fg('dim', text) });
  let choices, error, selected = 0, pasting = false, closed = false;
  function dispose() {
    closed = true;
    signal.removeEventListener('abort', abort);
  }
  function finish(value) {
    if (closed) return;
    dispose();
    done(value);
  }
  function abort() { finish(undefined); }
  if (signal.aborted) queueMicrotask(abort);
  else signal.addEventListener('abort', abort, { once: true });
  return {
    get focused() { return input.focused; },
    set focused(value) { input.focused = value; },
    dispose,
    invalidate() { input.invalidate(); },
    render(width) {
      if (width < 1) return [];
      const border = theme.fg('border', '─'.repeat(width));
      if (width < 4) return [border];
      const inset = (text) => ' ' + truncateToWidth(text, width - 1);
      const rows = [border, '', inset(theme.fg('accent', theme.bold(`Shortcut for /tmux-image ${action}`))), '',
        ...input.render(width - 1).map((row) => ' ' + row)];
      if (error) rows.push(inset(theme.fg('error', error)));
      if (choices?.length) {
        rows.push('', inset(theme.fg('dim', `↑/↓ choose · Enter fills (${selected + 1}/${choices.length})`)));
        const first = Math.max(0, selected - 4);
        for (const [i, key] of choices.slice(first, first + 5).entries()) {
          rows.push(inset(first + i === selected ? theme.fg('accent', `→ ${key}`) : `  ${key}`));
        }
      } else if (choices) rows.push('', inset(theme.fg('dim', 'No matching shortcuts without known conflicts.')));
      rows.push('', inset(theme.fg('dim', 'Tab: suggest · Enter: save (blank removes) · Esc: back')), '', border);
      return rows;
    },
    handleInput(data) {
      if (closed) return;
      if (pasting || data.includes('\x1b[200~')) {
        pasting = !data.includes('\x1b[201~');
        input.handleInput(data);
        error = choices = undefined;
      } else if (keybindings.matches(data, 'tui.select.cancel')) {
        return finish(undefined);
      } else if (keybindings.matches(data, 'tui.input.submit') || data === '\n') {
        if (isKeyRepeat?.(data)) return;
        if (choices?.length) {
          input.setValue(choices[selected]);
          choices = error = undefined;
        } else {
          let key;
          try { key = validate(input.getValue(), keybindings.getResolvedBindings()); }
          catch (reason) { error = reason.message; choices = undefined; }
          if (key !== undefined) return finish(key);
        }
      } else if (keybindings.matches(data, 'tui.input.tab')) {
        error = undefined;
        choices = suggest(input.getValue(), keybindings.getResolvedBindings());
        selected = 0;
      } else if (choices?.length && keybindings.matches(data, 'tui.select.up')) {
        selected = Math.max(0, selected - 1);
      } else if (choices?.length && keybindings.matches(data, 'tui.select.down')) {
        selected = Math.min(choices.length - 1, selected + 1);
      } else {
        choices = error = undefined;
        input.handleInput(data);
      }
      tui.requestRender();
    },
  };
}
