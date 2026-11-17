export function setCallParticipantName(label, name, platform) {
  const text = document.createElement('span');
  text.className = 'call-participant-name';
  text.textContent = name;
  label.replaceChildren(text);
  if (platform === 'web') {
    const badge = document.createElement('b');
    badge.className = 'call-web-badge';
    badge.textContent = 'W';
    badge.title = 'Using the website or desktop app';
    badge.setAttribute('aria-label', badge.title);
    label.append(badge);
  }
}
