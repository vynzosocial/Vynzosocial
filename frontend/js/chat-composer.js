export function attachChatComposer(input, form) {
  const resize = () => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
  };
  input.addEventListener('input', resize);
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229 ||
        event.ctrlKey || event.altKey || event.metaKey || window.matchMedia('(pointer: coarse)').matches) return;
    event.preventDefault();
    form.requestSubmit();
  });
  resize();
  return resize;
}
