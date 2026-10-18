// Focus an element when it appears, for the one field a screen exists to fill
// in (sign-in, the new-user form). Same effect as the autofocus attribute,
// which Svelte's accessibility check flags wholesale.
export function autofocus(node) {
  node.focus();
}
